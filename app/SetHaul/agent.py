"""
SETUHAUL — FREIGHT OPERATIONS ASSISTANT
=======================================

Architecture
------------

Driver
   |
   v
LangChain / LLM
   |
   +---- Redis
   |      - active conversation/session
   |      - current shipment
   |      - workflow state
   |      - selected slot
   |      - active hold
   |
   +---- Tools
          |
          v
       Supabase
          |
          +-- drivers
          +-- shipments
          +-- appointment_slots
          +-- appointments
          +-- driver_exceptions
          +-- eta_updates
          +-- chat_conversations
          +-- chat_messages

IMPORTANT
---------
Redis is NOT the source of truth for freight operations.

Supabase/PostgreSQL is the source of truth.

Redis is used for:
    - active chat session
    - short-term workflow state
    - selected shipment
    - selected slot
    - hold context
    - recent operational context

LangChain:
    LLM -> tool selection -> tool execution -> LLM response

PostgreSQL RPCs:
    hold_slot_atomic
    confirm_slot_atomic
    release_hold_atomic

Environment:
    SUPABASE_URL
    SUPABASE_KEY
    OPEN_ROUTER_API_KEY
    OPENROUTER_MODEL (optional)
    REDIS_URL

Recommended model:
    google/gemini-2.5-flash
"""

# ============================================================
# IMPORTS
# ============================================================

import os
import json
import uuid
import sys
import logging
import inspect
from functools import wraps
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import redis
from dotenv import load_dotenv
from supabase import create_client, Client

from pydantic import BaseModel, Field
from enum import Enum

from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.messages import (
    SystemMessage,
    HumanMessage,
    AIMessage,
    ToolMessage,
    messages_from_dict,
    messages_to_dict,
)
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnableLambda


# ============================================================
# LOGGING
# ============================================================

LOG_DIRECTORY = Path(__file__).resolve().parent / "logs" / "agent_logs"
LOG_DIRECTORY.mkdir(parents=True, exist_ok=True)
RUN_TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
LOG_FILE = LOG_DIRECTORY / f"agent_stdio_log_{RUN_TIMESTAMP}.logs"

log = logging.getLogger("setuhaul.agent")
log.setLevel(logging.DEBUG)
log.propagate = False

if not log.handlers:
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    log.addHandler(file_handler)


class TeeOutput:
    """Mirror existing print output to the terminal and the agent log file."""

    def __init__(self, terminal, log_path):
        self.terminal = terminal
        self.log_path = log_path

    def write(self, text):
        self.terminal.write(text)
        self.terminal.flush()
        if text:
            with self.log_path.open("a", encoding="utf-8") as output:
                output.write(text)

    def flush(self):
        self.terminal.flush()


sys.stdout = TeeOutput(sys.stdout, LOG_FILE)
sys.stderr = TeeOutput(sys.stderr, LOG_FILE)
log.info("Agent logging initialized. Transcript path: %s", LOG_FILE)


def _log_message_block(category: str, payload: Dict[str, Any]):
    """Write a clearly delimited, machine-readable chat/agent event to the log."""
    try:
        rendered = json.dumps(payload, ensure_ascii=False, default=str, indent=2)
    except Exception:
        rendered = str(payload)

    log.info(
        "\n%s %s %s\n%s\n%s",
        "=" * 24,
        category,
        "=" * 24,
        rendered,
        "=" * (50 + len(category)),
    )


def _log_ai_message(stage: str, response: AIMessage):
    """Capture the raw model message and any tool calls it requested."""
    _log_message_block("AI_MESSAGE", {
        "stage": stage,
        "content": response.content,
        "tool_calls": response.tool_calls or [],
        "response_metadata": response.response_metadata or {},
    })


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

OPEN_ROUTER_API_KEY = os.getenv("OPEN_ROUTER_API_KEY")

OPENROUTER_MODEL = os.getenv(
    "OPENROUTER_MODEL",
    "google/gemini-2.5-flash",
)

REDIS_URL = os.getenv("REDIS_URL")

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

MAX_HISTORY_MESSAGES = 20
DEFAULT_HOLD_SECONDS = 180
SESSION_TTL = 24 * 60 * 60


# ============================================================
# ENV VALIDATION
# ============================================================

missing = []

if not SUPABASE_URL:
    missing.append("SUPABASE_URL")

if not SUPABASE_KEY:
    missing.append("SUPABASE_KEY")

if not OPEN_ROUTER_API_KEY:
    missing.append("OPEN_ROUTER_API_KEY")

if not REDIS_URL:
    missing.append("REDIS_URL")

if missing:
    log.critical("Required environment variables are missing: %s", ", ".join(missing))
    raise RuntimeError(
        "Missing environment variables: "
        + ", ".join(missing)
    )


# ============================================================
# CLIENTS
# ============================================================

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY,
)

redis_client = redis.from_url(
    REDIS_URL,
    decode_responses=True,
)


# ============================================================
# DOMAIN / TOOL SCHEMAS
# (formerly schema.py — inlined here so the project is one file)
# ============================================================

class ExceptionTypeEnum(str, Enum):
    TRAFFIC_DELAY = "traffic_delay"
    MECHANICAL_BREAKDOWN = "mechanical_breakdown"
    WEATHER = "weather"
    OTHER = "other"


class IssueBucketEnum(str, Enum):
    DRIVER_VEHICLE = "driver_vehicle"
    ROUTE_EXTERNAL = "route_external"
    SHIPMENT_FACILITY = "shipment_facility"


class IssueCategoryEnum(str, Enum):
    TRAFFIC = "traffic"
    ROAD_ACCIDENT = "road_accident"
    ROAD_CLOSURE = "road_closure"
    ROAD_CONSTRUCTION = "road_construction"
    DIVERSION = "diversion"
    FLOOD = "flood"
    LANDSLIDE = "landslide"
    BRIDGE_CLOSURE = "bridge_closure"
    WEATHER_IMPACT = "weather_impact"
    FOG = "fog"
    TOLL_CHECKPOINT = "toll_checkpoint"
    POLICE_INSPECTION = "police_inspection"
    NAVIGATION = "navigation"
    PUNCTURE = "puncture"
    FLAT_TIRE = "flat_tire"
    ENGINE_FAILURE = "engine_failure"
    OVERHEATING = "overheating"
    BATTERY_FAILURE = "battery_failure"
    BRAKE_PROBLEM = "brake_problem"
    TRANSMISSION_FAILURE = "transmission_failure"
    ELECTRICAL_FAILURE = "electrical_failure"
    FUEL_PROBLEM = "fuel_problem"
    MECHANICAL_BREAKDOWN = "mechanical_breakdown"
    WORKSHOP_REPAIR = "workshop_repair"
    DRIVER_ILLNESS = "driver_illness"
    DRIVER_INJURY = "driver_injury"
    DRIVER_FATIGUE = "driver_fatigue"
    PERSONAL_EMERGENCY = "personal_emergency"
    SAFETY_ISSUE = "safety_issue"
    LOADING_DELAY = "loading_delay"
    UNLOADING_DELAY = "unloading_delay"
    WAITING_FOR_DOCK = "waiting_for_dock"
    FACILITY_QUEUE = "facility_queue"
    DOCK_CONGESTION = "dock_congestion"
    LIMITED_STAFF = "limited_staff"
    DOCK_UNAVAILABLE = "dock_unavailable"
    FACILITY_CLOSED = "facility_closed"
    GATE_DELAY = "gate_delay"
    SECURITY_DELAY = "security_delay"
    DOCUMENTATION_DELAY = "documentation_delay"
    SHIPMENT_NOT_READY = "shipment_not_ready"
    PREVIOUS_STOP_DELAY = "previous_stop_delay"
    CUSTOMER_DELAY = "customer_delay"
    OTHER_FACILITY = "other_facility"


WEATHER_ISSUE_CATEGORIES = {
    IssueCategoryEnum.FLOOD,
    IssueCategoryEnum.LANDSLIDE,
    IssueCategoryEnum.WEATHER_IMPACT,
    IssueCategoryEnum.FOG,
}
MECHANICAL_ISSUE_CATEGORIES = {
    IssueCategoryEnum.PUNCTURE,
    IssueCategoryEnum.FLAT_TIRE,
    IssueCategoryEnum.ENGINE_FAILURE,
    IssueCategoryEnum.OVERHEATING,
    IssueCategoryEnum.BATTERY_FAILURE,
    IssueCategoryEnum.BRAKE_PROBLEM,
    IssueCategoryEnum.TRANSMISSION_FAILURE,
    IssueCategoryEnum.ELECTRICAL_FAILURE,
    IssueCategoryEnum.FUEL_PROBLEM,
    IssueCategoryEnum.MECHANICAL_BREAKDOWN,
    IssueCategoryEnum.WORKSHOP_REPAIR,
}


def db_exception_type(issue_category: IssueCategoryEnum) -> str:
    """Map detailed app categories to the database's exception_type enum."""
    if issue_category == IssueCategoryEnum.TRAFFIC:
        return ExceptionTypeEnum.TRAFFIC_DELAY.value
    if issue_category in WEATHER_ISSUE_CATEGORIES:
        return ExceptionTypeEnum.WEATHER.value
    if issue_category in MECHANICAL_ISSUE_CATEGORIES:
        return ExceptionTypeEnum.MECHANICAL_BREAKDOWN.value
    return ExceptionTypeEnum.OTHER.value


class GetDriverShipmentInput(BaseModel):
    shipment_id: Optional[str] = Field(default=None, description="Specific shipment ID if known.")


class GetShipmentInput(BaseModel):
    shipment_id: str


class CheckExceptionInput(BaseModel):
    shipment_id: str


class RecordExceptionInput(BaseModel):
    shipment_id: str
    issue_category: IssueCategoryEnum
    reported_delay_minutes: int = Field(ge=1, le=1440)


class RecordETAInput(BaseModel):
    shipment_id: str
    declared_eta: str
    confidence_note: Optional[str] = None


class AppointmentStatusInput(BaseModel):
    shipment_id: str


class GateEntryStatusInput(BaseModel):
    shipment_id: str


class FacilityOperationStatusInput(BaseModel):
    shipment_id: str


class FacilityDelayAnalysisInput(BaseModel):
    shipment_id: str
    reported_delay_minutes: Optional[int] = Field(
        default=None, ge=1, le=1440,
        description="Known driver travel/operational delay in minutes. Do not invent this value."
    )
    waiting_since: Optional[str] = Field(
        default=None,
        description="ISO timestamp when driver reached bay/started waiting, if known.",
    )
    reported_wait_minutes: Optional[int] = Field(default=None, ge=1, le=1440)


class ApproveRescheduleInput(BaseModel):
    shipment_id: str


class CheckSlotInput(BaseModel):
    shipment_id: str
    after: Optional[str] = Field(
        default=None,
        description="ISO timestamp. If omitted, current UTC time is used.",
    )


class HoldSlotInput(BaseModel):
    slot_id: str
    shipment_id: str
    hold_seconds: int = Field(default=DEFAULT_HOLD_SECONDS, ge=30, le=900)


class ConfirmSlotInput(BaseModel):
    slot_id: str
    shipment_id: str


class ReleaseHoldInput(BaseModel):
    slot_id: str


class EscalateInput(BaseModel):
    shipment_id: str
    reason: str


class DriverAvailabilityInput(BaseModel):
    availability_status: str = Field(
        description="One of: available, unavailable, on_trip."
    )


class FindAvailableDriversInput(BaseModel):
    shipment_id: str
    limit: int = Field(default=5, ge=1, le=10)


class RequestDriverReassignmentInput(BaseModel):
    shipment_id: str
    replacement_driver_id: str
    reason: str


class OperationalStateInput(BaseModel):
    shipment_id: str
    state_type: str = Field(description="One of: early_waiting, late_waiting, unloading, eta_declared.")
    note: Optional[str] = None


class WarehouseScheduleReportInput(BaseModel):
    shipment_id: str
    reported_start_time: Optional[str] = None
    reported_end_time: Optional[str] = None
    note: Optional[str] = None



# ============================================================
# UTILITIES
# ============================================================

# IST is permanently UTC+05:30; using a fixed offset keeps this portable on
# Windows installations that do not have the optional IANA ``tzdata`` package.
DISPLAY_TIMEZONE = timezone(timedelta(hours=5, minutes=30), name="IST")
DISPLAY_TIMESTAMP_FIELDS = {
    "planned_eta",
    "current_eta",
    "declared_eta",
    "updated_eta",
    "start_time",
    "end_time",
    "held_until",
    "confirmed_at",
    "booked_at",
    "reported_at",
    "created_at",
    "updated_at",
}


def format_timestamp_ist(value: Any) -> Optional[str]:
    """Return an ISO timestamp as an unambiguous India Standard Time label."""
    if not isinstance(value, str) or not value.strip():
        return None

    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            # Operational timestamps without an offset are stored as UTC.
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(DISPLAY_TIMEZONE).strftime("%d %b %Y, %I:%M %p IST")
    except ValueError:
        return None


def normalize_eta_to_ist(value: str) -> str:
    """Normalize an ETA to ISO-8601 with an explicit IST (+05:30) offset."""
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        # A driver-entered time without an offset is understood as local IST.
        parsed = parsed.replace(tzinfo=DISPLAY_TIMEZONE)
    return parsed.astimezone(DISPLAY_TIMEZONE).isoformat()


def add_ist_display_fields(data: Any) -> Any:
    """Add IST labels to timestamp fields returned to the language model/driver."""
    if isinstance(data, list):
        return [add_ist_display_fields(item) for item in data]
    if not isinstance(data, dict):
        return data

    result = {}
    for key, value in data.items():
        result[key] = add_ist_display_fields(value)
        if key in DISPLAY_TIMESTAMP_FIELDS:
            formatted = format_timestamp_ist(value)
            if formatted:
                result[f"{key}_ist"] = formatted
    return result


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def generate_id(prefix: str) -> str:
    return (
        f"{prefix}-"
        f"{uuid.uuid4().hex[:8].upper()}"
    )


def json_dumps(data: Any) -> str:
    try:
        return json.dumps(
            add_ist_display_fields(data),
            default=str,
            ensure_ascii=False,
        )
    except Exception:
        return json.dumps(
            {
                "status": "error",
                "message": str(data),
            }
        )


def db_error(error: Exception) -> Dict[str, Any]:
    """
    Never expose raw DB errors to the LLM as the final response.
    The LLM gets a structured operational error.
    """

    log.error("Supabase operation failed: %s", error)
    print(
        f"\n[SUPABASE ERROR] {error}\n"
    )

    return {
        "status": "error",
        "message": "The freight operations database could not complete this request.",
        "technical_error": str(error),
    }


# ============================================================
# REDIS SESSION MANAGER
# ============================================================

class SessionManager:
    """
    Redis-backed active conversation/workflow state.

    Redis is intentionally NOT used as the permanent database.
    """

    def __init__(
        self,
        client,
        ttl: int = SESSION_TTL,
    ):
        self.redis = client
        self.ttl = ttl

    def driver_session_key(
        self,
        driver_id: str,
    ) -> str:
        return (
            f"setuhaul:"
            f"driver:{driver_id}:"
            f"active_session"
        )

    def session_key(
        self,
        conversation_id: str,
    ) -> str:
        return (
            f"setuhaul:"
            f"session:{conversation_id}"
        )

    def get_or_create(
        self,
        driver_id: str,
    ) -> str:

        driver_key = self.driver_session_key(
            driver_id
        )

        existing = self.redis.get(
            driver_key
        )

        if existing:

            self.redis.expire(
                driver_key,
                self.ttl,
            )

            self.redis.expire(
                self.session_key(existing),
                self.ttl,
            )

            return existing

        conversation_id = generate_id(
            "CONV"
        )

        state = {
            "conversation_id": conversation_id,
            "driver_id": driver_id,
            "shipment_id": None,
            "workflow": "idle",
            "current_step": None,
            "selected_slot": None,
            "selected_slot_details": None,
            "hold_until": None,
            "last_exception_id": None,
            "last_eta": None,
            "created_at": now_iso(),
            "last_activity": now_iso(),
        }

        pipe = self.redis.pipeline()

        pipe.set(
            driver_key,
            conversation_id,
            ex=self.ttl,
        )

        pipe.set(
            self.session_key(conversation_id),
            json_dumps(state),
            ex=self.ttl,
        )

        pipe.execute()

        return conversation_id

    def get_state(
        self,
        conversation_id: str,
    ) -> Dict[str, Any]:

        raw = self.redis.get(
            self.session_key(conversation_id)
        )

        if not raw:
            return {}

        try:
            state = json.loads(raw)
        except Exception:
            return {}

        self.redis.expire(
            self.session_key(conversation_id),
            self.ttl,
        )

        return state

    def update(
        self,
        conversation_id: str,
        **updates,
    ) -> Dict[str, Any]:

        key = self.session_key(
            conversation_id
        )

        state = self.get_state(
            conversation_id
        )

        if not state:
            state = {
                "conversation_id": conversation_id
            }

        state.update(updates)

        state["last_activity"] = now_iso()

        self.redis.set(
            key,
            json_dumps(state),
            ex=self.ttl,
        )

        return state

    def clear_workflow(
        self,
        conversation_id: str,
    ):

        return self.update(
            conversation_id,
            shipment_id=None,
            workflow="idle",
            current_step=None,
            selected_slot=None,
            selected_slot_details=None,
            hold_until=None,
            last_exception_id=None,
            last_eta=None,
        )

    def delete_session(
        self,
        driver_id: str,
        conversation_id: str,
    ):

        self.redis.delete(
            self.driver_session_key(
                driver_id
            )
        )

        self.redis.delete(
            self.session_key(
                conversation_id
            )
        )


session_manager = SessionManager(
    redis_client
)


# ============================================================
# REDIS HEALTH CHECK
# ============================================================

def check_redis() -> bool:

    try:

        redis_client.ping()

        print(
            "[Redis] Connected successfully"
        )
        log.info("Redis connection check passed.")

        return True

    except Exception as exc:

        log.error("Redis connection check failed: %s", exc)
        print(
            f"[Redis] Connection failed: {exc}"
        )

        return False


# ============================================================
# DRIVER
# ============================================================

def get_driver(
    driver_id: str,
) -> Optional[Dict[str, Any]]:

    try:

        response = (
            supabase
            .table("drivers")
            .select("*")
            .eq(
                "driver_id",
                driver_id,
            )
            .limit(1)
            .execute()
        )

        if response.data:
            return response.data[0]

        return None

    except Exception as exc:

        print(
            f"[get_driver error] {exc}"
        )

        return None


def validate_driver(
    driver_id: str,
) -> bool:

    return (
        get_driver(driver_id)
        is not None
    )


# ============================================================
# DRIVER PHONE VERIFICATION
# ============================================================

def normalize_phone(phone: str) -> str:
    """Normalize a phone number to its last 10 digits."""
    if not phone:
        return ""
    digits = "".join(c for c in str(phone) if c.isdigit())
    if len(digits) > 10:
        digits = digits[-10:]
    return digits


def verify_driver_phone(driver_id: str, entered_phone: str) -> bool:
    """Verify entered phone against the driver's registered phone."""
    driver = get_driver(driver_id)
    if not driver:
        return False
    registered_phone = driver.get("phone")
    if not registered_phone:
        return False
    entered = normalize_phone(entered_phone)
    registered = normalize_phone(registered_phone)
    return bool(entered) and entered == registered


def authenticate_driver() -> Optional[str]:
    """Authenticate the driver using Driver ID + registered phone."""
    print()
    print("Driver authentication")
    print("---------------------")

    while True:
        driver_id = input("Driver ID: ").strip().upper()
        if not driver_id:
            print("Driver ID is required.\n")
            continue

        driver = get_driver(driver_id)
        if not driver:
            print(f"Driver '{driver_id}' was not found.\n")
            continue

        status = driver.get("status")
        if status and str(status).lower() != "active":
            print("This driver account is not active.\n")
            continue

        if not driver.get("phone"):
            print("This driver account has no registered phone number.\n")
            continue

        print()
        print(f"Driver found: {driver.get('name', driver_id)}")
        print()
        entered_phone = input("Registered mobile number: ").strip()

        if not verify_driver_phone(driver_id, entered_phone):
            print("\nMobile number verification failed.")
            print("The number does not match the registered driver account.\n")
            continue

        print("\n[AUTH] Driver verified successfully.\n")
        return driver_id


# ============================================================
# SHIPMENTS
# ============================================================

def get_shipment(
    shipment_id: str,
) -> Optional[Dict[str, Any]]:

    try:

        response = (
            supabase
            .table("shipments")
            .select("*")
            .eq(
                "shipment_id",
                shipment_id,
            )
            .limit(1)
            .execute()
        )

        if response.data:
            return response.data[0]

        return None

    except Exception as exc:

        print(
            f"[get_shipment error] {exc}"
        )

        return None


def get_driver_shipments(
    driver_id: str,
    active_only: bool = True,
) -> List[Dict[str, Any]]:

    try:

        query = (
            supabase
            .table("shipments")
            .select("*")
            .eq(
                "driver_id",
                driver_id,
            )
        )

        if active_only:

            query = query.in_(
                "status",
                [
                    "planned",
                    "in_transit",
                    "arrived",
                ],
            )

        response = query.execute()

        return response.data or []

    except Exception as exc:

        print(
            f"[get_driver_shipments error] {exc}"
        )

        return []


def shipment_belongs_to_driver(
    shipment_id: str,
    driver_id: str,
) -> bool:

    shipment = get_shipment(
        shipment_id
    )

    if not shipment:
        return False

    return (
        shipment.get("driver_id")
        == driver_id
    )


# ============================================================
# APPOINTMENT
# ============================================================

def get_current_appointment(
    shipment_id: str,
) -> Optional[Dict[str, Any]]:

    try:

        response = (
            supabase
            .table("appointments")
            .select(
                "*, appointment_slots(*)"
            )
            .eq(
                "shipment_id",
                shipment_id,
            )
            .eq(
                "status",
                "confirmed",
            )
            .order(
                "confirmed_at",
                desc=True,
            )
            .limit(1)
            .execute()
        )

        if response.data:
            return response.data[0]

        return None

    except Exception as exc:

        print(
            f"[appointment error] {exc}"
        )

        return None

    
# ============================================================
# TOOLS
# ============================================================

@tool(
    "get_driver_shipments",
    args_schema=GetDriverShipmentInput,
)
def get_driver_shipments_tool(
    shipment_id: Optional[str] = None,
) -> str:
    """
    Get the authenticated driver's active shipments.

    If shipment_id is supplied, retrieve that shipment.
    Never access another driver's shipment.
    """

    # Driver is injected at runtime.
    # The actual driver is attached through TOOL_CONTEXT.
    driver_id = TOOL_CONTEXT["driver_id"]

    try:

        if shipment_id:

            shipment = get_shipment(
                shipment_id
            )

            if not shipment:

                return json_dumps({
                    "status": "not_found",
                    "message": "Shipment was not found.",
                })

            if (
                shipment.get("driver_id")
                != driver_id
            ):

                return json_dumps({
                    "status": "forbidden",
                    "message": "Shipment does not belong to the authenticated driver.",
                })

            return json_dumps({
                "status": "success",
                "shipments": [shipment],
            })

        shipments = get_driver_shipments(
            driver_id,
            active_only=True,
        )

        return json_dumps({
            "status": "success",
            "shipments": shipments,
        })

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )
def calculate_updated_eta(
    shipment_id: str,
    delay_minutes: int,
) -> Optional[str]:

    response = (
        supabase
        .table("shipments")
        .select("planned_eta")
        .eq("shipment_id", shipment_id)
        .single()
        .execute()
    )

    if not response.data:
        return None

    planned_eta = response.data["planned_eta"]

    eta_dt = datetime.fromisoformat(
        planned_eta.replace("Z", "+00:00")
    )

    updated_eta = (
        eta_dt
        + timedelta(minutes=delay_minutes)
    )

    return updated_eta.isoformat()

@tool(
    "get_shipment",
    args_schema=GetShipmentInput,
)
def get_shipment_tool(
    shipment_id: str,
) -> str:
    """
    Get detailed information for one shipment belonging
    to the authenticated driver.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    shipment = get_shipment(
        shipment_id
    )

    if not shipment:

        return json_dumps({
            "status": "not_found",
            "message": "Shipment was not found.",
        })

    if (
        shipment.get("driver_id")
        != driver_id
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    return json_dumps({
        "status": "success",
        "shipment": shipment,
    })


@tool(
    "get_current_eta",
    args_schema=GetShipmentInput,
)
def get_current_eta(
    shipment_id: str,
) -> str:
    """Get the authenticated driver's latest current ETA for a shipment."""
    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:
        latest_update = (
            supabase
            .table("eta_updates")
            .select("eta_update_id, declared_eta, declared_at, source_type, confidence_note")
            .eq("shipment_id", shipment_id)
            .order("declared_at", desc=True)
            .limit(1)
            .execute()
        )

        if latest_update.data:
            eta = latest_update.data[0]
            return json_dumps({
                "status": "success",
                "shipment_id": shipment_id,
                "current_eta": eta.get("declared_eta"),
                "eta_source": "latest_eta_update",
                "eta_update_id": eta.get("eta_update_id"),
                "updated_at": eta.get("declared_at"),
            })

        shipment = get_shipment(shipment_id)
        if not shipment or not shipment.get("planned_eta"):
            return json_dumps({
                "status": "not_found",
                "message": "No ETA is available for this shipment.",
            })

        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "current_eta": shipment.get("planned_eta"),
            "eta_source": "planned_eta",
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool(
    "get_appointment_status",
    args_schema=AppointmentStatusInput,
)
def get_appointment_status(
    shipment_id: str,
) -> str:
    """
    Get the current pending or confirmed appointment.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):
        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    appointment = get_current_appointment(
        shipment_id
    )

    if not appointment:
        return json_dumps({
            "status": "no_active_appointment",
        })

    slot = (
        appointment.get(
            "appointment_slots"
        )
        or {}
    )
    print(
    "[DEBUG] get_appointment_status:",
    json_dumps({
        "start_time": slot.get("start_time"),
        "end_time": slot.get("end_time"),
        "slot_id": appointment.get("slot_id"),
    })
)

    return json_dumps({
        "status": "success",
        "appointment_id": appointment.get(
            "appointment_id"
        ),
        "appointment_status": appointment.get(
            "status"
        ),
        "slot_id": appointment.get(
            "slot_id"
        ),
        "dock_id": slot.get(
            "dock_id"
        ),
        "facility_id": slot.get(
            "facility_id"
        ),
        "start_time": slot.get(
            "start_time"
        ),
        "end_time": slot.get(
            "end_time"
        ),
        "confirmed_at": appointment.get(
            "confirmed_at"
        ),
    })


@tool(
    "get_gate_entry_status",
    args_schema=GateEntryStatusInput,
)
def get_gate_entry_status(
    shipment_id: str,
) -> str:
    """Return the authenticated driver's vehicle pre-registration and gate-entry status.

    This is read-only. Gate security, not the driver or LLM, approves or denies entry.
    """
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:
        shipment = get_shipment(shipment_id)
        entry_response = (
            supabase.table("gate_entries")
            .select("*")
            .eq("shipment_id", shipment_id)
            .order("expected_at", desc=True)
            .limit(1)
            .execute()
        )
        if not entry_response.data:
            return json_dumps({
                "status": "not_pre_registered",
                "shipment_id": shipment_id,
                "message": "No gate pre-registration was found for this shipment. Please contact facility operations.",
            })

        entry = entry_response.data[0]
        vehicle_response = (
            supabase.table("vehicles").select("*")
            .eq("vehicle_id", entry["vehicle_id"]).limit(1).execute()
        )
        gate_response = (
            supabase.table("gates").select("*")
            .eq("gate_id", entry["gate_id"]).limit(1).execute()
        )
        vehicle = vehicle_response.data[0] if vehicle_response.data else {}
        gate = gate_response.data[0] if gate_response.data else {}
        entry_status = entry.get("entry_status")
        security_status = entry.get("security_check_status")
        entry_allowed = entry_status in ("approved", "checked_in") and security_status == "passed"

        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "entry_allowed": entry_allowed,
            "gate_entry": entry,
            "gate": gate,
            "vehicle": vehicle,
            "guidance": (
                "Gate entry is approved." if entry_allowed else
                "The vehicle is expected/pre-registered, but gate security has not approved entry yet."
                if entry_status == "expected" else
                "Gate entry is not currently approved. Please follow facility security instructions."
            ),
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool(
    "get_facility_operation_status",
    args_schema=FacilityOperationStatusInput,
)
def get_facility_operation_status(
    shipment_id: str,
) -> str:
    """Return the authenticated driver's dock assignment and unloading progress.

    This is read-only. Facility staff control dock assignment and unloading updates.
    """
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:
        assignment_response = (
            supabase.table("dock_assignments")
            .select("*")
            .eq("shipment_id", shipment_id)
            .order("assigned_at", desc=True)
            .limit(1)
            .execute()
        )
        if not assignment_response.data:
            return json_dumps({
                "status": "not_assigned",
                "shipment_id": shipment_id,
                "message": "Facility operations have not assigned a dock yet.",
            })

        assignment = assignment_response.data[0]
        unloading_response = (
            supabase.table("unloading_operations")
            .select("*")
            .eq("dock_assignment_id", assignment["dock_assignment_id"])
            .limit(1)
            .execute()
        )
        dock_response = (
            supabase.table("docks").select("*")
            .eq("dock_id", assignment["dock_id"]).limit(1).execute()
        )
        unloading = unloading_response.data[0] if unloading_response.data else None
        dock = dock_response.data[0] if dock_response.data else {}

        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "dock_assignment": assignment,
            "dock": dock,
            "unloading_operation": unloading,
            "guidance": (
                "Unloading is in progress." if unloading and unloading.get("operation_status") == "in_progress" else
                "Unloading is complete." if unloading and unloading.get("operation_status") == "completed" else
                "A dock and unloading operation are scheduled; wait for facility staff to confirm arrival at the dock."
            ),
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool(
    "check_existing_open_exception",
    args_schema=CheckExceptionInput,
)
def check_existing_open_exception(
    shipment_id: str,
) -> str:
    """
    Check whether an open driver exception already exists.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:

        # IMPORTANT:
        # Your actual DB previously showed that reported_at
        # does NOT exist.
        #
        # Therefore we deliberately DO NOT order by reported_at.

        response = (
            supabase
            .table("driver_exceptions")
            .select("*")
            .eq(
                "shipment_id",
                shipment_id,
            )
            .eq(
                "driver_id",
                driver_id,
            )
            .eq(
                "status",
                "open",
            )
            .limit(1)
            .execute()
        )

        if not response.data:

            return json_dumps({
                "status": "none_open",
            })

        exception = response.data[0]

        return json_dumps({
            "status": "open_exists",
            "exception": exception,
        })

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )


@tool(
    "record_exception",
    args_schema=RecordExceptionInput,
)
def record_exception(
    shipment_id: str,
    issue_category: IssueCategoryEnum,
    reported_delay_minutes: int,
) -> str:
    """Record an authorized driver's shipment exception and reported delay."""

    driver_id = TOOL_CONTEXT["driver_id"]

    # ---------------------------------------------------------
    # AUTHORIZATION
    # ---------------------------------------------------------

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):
        return json_dumps({
            "status": "forbidden",
            "message": (
                "Shipment does not belong "
                "to the authenticated driver."
            ),
        })

    # ---------------------------------------------------------
    # VALIDATE DELAY
    # ---------------------------------------------------------

    if reported_delay_minutes < 1:
        return json_dumps({
            "status": "error",
            "message": (
                "Delay must be at least 1 minute."
            ),
        })

    try:

        # -----------------------------------------------------
        # 1. CREATE EXCEPTION
        # -----------------------------------------------------

        existing = (
            supabase.table("driver_exceptions")
            .select("exception_id")
            .eq("shipment_id", shipment_id)
            .eq("status", "open")
            .limit(1)
            .execute()
        )

        exception_id = (
            existing.data[0]["exception_id"]
            if existing.data
            else generate_id("EXC")
        )

        payload = {
            "exception_id": exception_id,
            "shipment_id": shipment_id,
            "driver_id": driver_id,
            # The Supabase table has ``exception_type`` (not
            # ``issue_category``) and its enum accepts only broad buckets.
            "exception_type": db_exception_type(issue_category),
            "reported_delay_minutes": (
                reported_delay_minutes
            ),
            "status": "open",
        }

        if existing.data:
            response = (
                supabase.table("driver_exceptions")
                .update({
                    "exception_type": payload["exception_type"],
                    "reported_delay_minutes": reported_delay_minutes,
                })
                .eq("exception_id", exception_id)
                .execute()
            )
        else:
            response = (
                supabase
                .table("driver_exceptions")
                .insert(payload)
                .execute()
            )

        # -----------------------------------------------------
        # 2. SAVE WORKFLOW STATE
        # -----------------------------------------------------

        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            shipment_id=shipment_id,
            exception_id=exception_id,
            issue_category=(
                issue_category.value
                if hasattr(issue_category, "value")
                else str(issue_category)
            ),
            reported_delay_minutes=(
                reported_delay_minutes
            ),
        )

        # -----------------------------------------------------
        # 3. CALCULATE UPDATED ETA
        # -----------------------------------------------------

        # A repair duration is not necessarily an ETA shift. The driver must
        # provide a revised arrival time (record_eta_update) after the issue
        # is recorded; do not invent one from planned_eta + delay.
        eta_result = {
            "status": "revised_eta_required",
            "message": "Ask the driver for their revised arrival time.",
        }

        # -----------------------------------------------------
        # 5. RETURN COMPLETE OPERATION RESULT
        # -----------------------------------------------------

        return json_dumps({
            "status": "success",

            "exception": {
                "exception_id": exception_id,
                "shipment_id": shipment_id,
                "issue_category": (
                    issue_category.value
                    if hasattr(issue_category, "value")
                    else str(issue_category)
                ),
                "reported_delay_minutes": (
                    reported_delay_minutes
                ),
            },

            "eta": eta_result,

            "next_step": (
                "Check the current appointment and "
                "determine whether the updated ETA can "
                "still meet the appointment."
            ),
        })

    except Exception as exc:

        print(
            f"[record_exception error] {exc}"
        )

        return json_dumps(
            db_error(exc)
        )

    
def calculate_updated_eta(
    shipment_id: str,
    delay_minutes: int,
) -> Optional[str]:
    """
    Calculate updated ETA from the shipment's current planned ETA
    plus the driver-reported delay.

    This is deterministic Python logic.
    The LLM does NOT calculate the timestamp.
    """

    try:
        response = (
            supabase
            .table("shipments")
            .select("planned_eta")
            .eq(
                "shipment_id",
                shipment_id,
            )
            .single()
            .execute()
        )

        if not response.data:
            return None

        planned_eta = response.data.get(
            "planned_eta"
        )

        if not planned_eta:
            return None

        eta_dt = datetime.fromisoformat(
            planned_eta.replace(
                "Z",
                "+00:00",
            )
        )

        updated_eta = (
            eta_dt
            + timedelta(
                minutes=delay_minutes
            )
        )

        return updated_eta.isoformat()

    except Exception as exc:

        print(
            f"[ETA calculation error] {exc}"
        )

        return None
def persist_eta_update(
    shipment_id: str,
    declared_eta: str,
    confidence_note: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Internal helper used by the exception workflow.
    This avoids recursively invoking a LangChain tool.
    """

    try:

        normalized_eta = normalize_eta_to_ist(declared_eta)

        # ``record_exception`` already persists its calculated ETA. If the
        # model subsequently calls ``record_eta_update`` with that same ETA,
        # do not create a duplicate audit row.
        existing = (
            supabase
            .table("eta_updates")
            .select("eta_update_id, declared_eta")
            .eq("shipment_id", shipment_id)
            .eq("declared_eta", normalized_eta)
            .limit(1)
            .execute()
        )
        if existing.data:
            return {
                "status": "already_recorded",
                "eta_update_id": existing.data[0].get("eta_update_id"),
                "declared_eta": normalized_eta,
            }

        eta_id = generate_id("ETA")

        payload = {
            "eta_update_id": eta_id,
            "shipment_id": shipment_id,
            "declared_eta": normalized_eta,
            "source_type": "driver",
            "confidence_note": confidence_note,
        }

        response = (
            supabase
            .table("eta_updates")
            .insert(payload)
            .execute()
        )

        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            shipment_id=shipment_id,
            last_eta=normalized_eta,
            workflow="eta_declared",
            current_step="appointment_impact_pending",
        )

        return {
            "status": "success",
            "eta_update_id": eta_id,
            "declared_eta": normalized_eta,
            "data": response.data,
        }

    except Exception as exc:

        return db_error(exc)

@tool(
    "record_eta_update",
    args_schema=RecordETAInput,
)
def record_eta_update(
    shipment_id: str,
    declared_eta: str,
    confidence_note: Optional[str] = None,
) -> str:
    """
    Persist a driver-declared ETA.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):
        return json_dumps({
            "status": "forbidden",
            "message": (
                "Shipment does not belong "
                "to the authenticated driver."
            ),
        })

    result = persist_eta_update(
        shipment_id=shipment_id,
        declared_eta=declared_eta,
        confidence_note=confidence_note,
    )

    return json_dumps(result)


@tool("report_operational_state", args_schema=OperationalStateInput)
def report_operational_state(shipment_id: str, state_type: str, note: Optional[str] = None) -> str:
    """Record a driver's observed waiting, unloading, or ETA state for a shipment."""
    driver_id = TOOL_CONTEXT["driver_id"]
    allowed = {"early_waiting", "late_waiting", "unloading", "eta_declared"}
    if state_type not in allowed:
        return json_dumps({"status": "validation_error", "message": "Unsupported operational state."})
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({"status": "forbidden", "message": "Shipment does not belong to the authenticated driver."})
    try:
        recent = (supabase.table("shipment_operational_states").select("state_event_id")
                  .eq("shipment_id", shipment_id).eq("driver_id", driver_id)
                  .eq("state_type", state_type).order("reported_at", desc=True).limit(1).execute())
        if recent.data:
            return json_dumps({"status": "already_recorded", "state_event_id": recent.data[0]["state_event_id"]})
        event_id = generate_id("STATE")
        supabase.table("shipment_operational_states").insert({
            "state_event_id": event_id, "shipment_id": shipment_id, "driver_id": driver_id,
            "state_type": state_type, "note": note, "idempotency_key": event_id,
        }).execute()
        return json_dumps({"status": "success", "state_event_id": event_id, "state_type": state_type})
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool("report_warehouse_schedule", args_schema=WarehouseScheduleReportInput)
def report_warehouse_schedule(
    shipment_id: str,
    reported_start_time: Optional[str] = None,
    reported_end_time: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """Record a warehouse-reported schedule and flag disagreement with the stored appointment."""
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({"status": "forbidden", "message": "Shipment does not belong to the authenticated driver."})
    try:
        appointment = get_current_appointment(shipment_id)
        stored_slot = (appointment or {}).get("appointment_slots") or {}
        reported_start = normalize_eta_to_ist(reported_start_time) if reported_start_time else None
        reported_end = normalize_eta_to_ist(reported_end_time) if reported_end_time else None
        mismatch = bool(
            (reported_start and _parse_dt(reported_start) != _parse_dt(stored_slot.get("start_time")))
            or (reported_end and _parse_dt(reported_end) != _parse_dt(stored_slot.get("end_time")))
        )
        report_id = generate_id("WHR")
        supabase.table("warehouse_schedule_reports").insert({
            "report_id": report_id, "shipment_id": shipment_id,
            "reported_start_time": reported_start, "reported_end_time": reported_end,
            "note": note, "idempotency_key": report_id,
        }).execute()
        if mismatch:
            TOOL_CONTEXT["session_manager"].update(TOOL_CONTEXT["conversation_id"], shipment_id=shipment_id, workflow="schedule_conflict", current_step="human_review_required")
        return json_dumps({"status": "schedule_conflict" if mismatch else "matches_stored_schedule", "report_id": report_id, "stored_start_time": stored_slot.get("start_time"), "stored_end_time": stored_slot.get("end_time")})
    except Exception as exc:
        return json_dumps(db_error(exc))

# ============================================================
# FACILITY / DOCK OPERATIONAL ANALYSIS
# ============================================================



def _parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        s = str(value).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _minutes_between(start: Optional[datetime], end: Optional[datetime]) -> Optional[int]:
    if not start or not end:
        return None
    return max(0, int((end - start).total_seconds() / 60))


def _extract_staff_count(dock: Dict[str, Any]) -> Optional[int]:
    for key in (
        "staff_count", "available_staff", "unloading_staff",
        "workers_available", "team_size", "worker_count",
    ):
        value = dock.get(key)
        if isinstance(value, int):
            return value
        if value is not None:
            try:
                return int(value)
            except Exception:
                pass
    return None


def _safe_optional_table(table_name: str) -> Optional[List[Dict[str, Any]]]:
    try:
        return supabase.table(table_name).select("*").limit(100).execute().data or []
    except Exception:
        return None


@tool("analyze_facility_delay", args_schema=FacilityDelayAnalysisInput)
def analyze_facility_delay(
    shipment_id: str,
    reported_delay_minutes: Optional[int] = None,
    waiting_since: Optional[str] = None,
    reported_wait_minutes: Optional[int] = None,
) -> str:
    """
    Analyze a driver waiting for unloading/loading at the assigned facility.

    Identifies the current appointment/dock, observable dock staffing or
    capacity information, same-dock appointment queue, and whether the
    current appointment appears feasible. This tool NEVER moves another
    driver's appointment and NEVER books a replacement slot.
    """
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({"status": "forbidden", "message": "Shipment does not belong to the authenticated driver."})

    try:
        shipment = get_shipment(shipment_id)
        appointment = get_current_appointment(shipment_id)
        if not shipment:
            return json_dumps({"status": "not_found", "message": "Shipment was not found."})
        if not appointment:
            return json_dumps({"status": "no_active_appointment", "message": "There is no active appointment to assess."})

        slot = appointment.get("appointment_slots") or {}
        dock_id = slot.get("dock_id")
        facility_id = slot.get("facility_id") or shipment.get("destination_id")
        if not dock_id:
            return json_dumps({"status": "insufficient_data", "message": "The current appointment does not identify a dock."})

        now = datetime.now(timezone.utc)
        wait_start = _parse_dt(waiting_since)
        observed_wait = reported_wait_minutes
        if wait_start and observed_wait is None:
            observed_wait = _minutes_between(wait_start, now)

        dock = None
        try:
            r = supabase.table("docks").select("*").eq("dock_id", dock_id).limit(1).execute()
            dock = r.data[0] if r.data else None
        except Exception:
            pass

        queue = []
        try:
            r = (supabase.table("appointments").select("*, appointment_slots(*)")
                 .in_("status", ["pending", "confirmed"]).execute())
            for row in r.data or []:
                if row.get("appointment_id") == appointment.get("appointment_id"):
                    continue
                rs = row.get("appointment_slots") or {}
                if rs.get("dock_id") != dock_id:
                    continue
                row_start = _parse_dt(rs.get("start_time"))
                row_end = _parse_dt(rs.get("end_time"))
                if row_end and row_end <= now:
                    continue
                queue.append({
                    "appointment_id": row.get("appointment_id"),
                    "shipment_id": row.get("shipment_id"),
                    "status": row.get("status"),
                    "start_time": rs.get("start_time"),
                    "end_time": rs.get("end_time"),
                    "active_now": bool(row_start and row_end and row_start <= now < row_end),
                })
            queue.sort(key=lambda x: _parse_dt(x.get("start_time")) or datetime.max.replace(tzinfo=timezone.utc))
        except Exception as exc:
            print(f"[facility analysis queue warning] {exc}")

        capacity_events = _safe_optional_table("facility_capacity_changes") or []
        active_capacity_events = []
        for event in capacity_events:
            ef = event.get("facility_id") or event.get("destination_id")
            if facility_id and ef and ef != facility_id:
                continue
            start_time = _parse_dt(event.get("effective_from") or event.get("start_time"))
            end_time = _parse_dt(event.get("effective_to") or event.get("end_time"))
            if start_time and start_time <= now and (not end_time or now < end_time):
                active_capacity_events.append(event)

        staff_count = _extract_staff_count(dock or {})
        active_queue = [x for x in queue if x.get("active_now")]
        current_start = _parse_dt(slot.get("start_time"))
        current_end = _parse_dt(slot.get("end_time"))
        appointment_window_missed = bool(current_end and now > current_end)

        estimated_wait = None
        active_ends = [_parse_dt(x.get("end_time")) for x in active_queue]
        active_ends = [x for x in active_ends if x]
        if active_ends:
            estimated_wait = max(0, int((max(active_ends) - now).total_seconds() / 60))

        # Deterministic travel/operational delay feasibility.
        # The LLM is NOT allowed to decide whether a 30/90/600 minute delay
        # still fits the appointment window.
        projected_arrival = None
        if reported_delay_minutes is not None:
            projected_arrival = now + timedelta(minutes=reported_delay_minutes)

        projected_service_start = projected_arrival
        if projected_service_start is not None and estimated_wait is not None:
            projected_service_start = projected_service_start + timedelta(minutes=estimated_wait)

        current_feasible = True
        feasibility_reasons = []

        if appointment_window_missed:
            current_feasible = False
            feasibility_reasons.append("appointment_window_already_ended")

        if projected_arrival is not None and current_end and projected_arrival > current_end:
            current_feasible = False
            feasibility_reasons.append("reported_delay_pushes_arrival_past_appointment_end")

        if projected_service_start is not None and current_end and projected_service_start > current_end:
            current_feasible = False
            feasibility_reasons.append("queue_wait_pushes_service_past_appointment_end")

        if reported_delay_minutes is None and estimated_wait is None and not appointment_window_missed:
            feasibility_reasons.append("insufficient_delay_or_queue_data")

        # Explicit capacity-change events can make the current appointment infeasible.
        capacity_signal = None
        for event in active_capacity_events:
            text_value = str(event.get("change_type") or event.get("event_type") or event.get("reason") or "").lower()
            if any(word in text_value for word in ("closed", "closure", "reduced", "staff", "labor", "labour", "capacity")):
                capacity_signal = event
                current_feasible = False
                break

        reschedule_required = not current_feasible

        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            shipment_id=shipment_id,
            workflow="reschedule_analysis" if reschedule_required else "facility_delay",
            current_step="reschedule_required" if reschedule_required else "appointment_still_feasible",
            current_dock_id=dock_id,
            current_facility_id=facility_id,
            facility_delay_analysis={
                "reschedule_required": reschedule_required,
                "estimated_wait_minutes": estimated_wait,
                "reported_delay_minutes": reported_delay_minutes,
                "projected_arrival": projected_arrival.isoformat() if projected_arrival else None,
                "projected_service_start": projected_service_start.isoformat() if projected_service_start else None,
                "feasibility_reasons": feasibility_reasons,
                "queue_size": len(queue),
            },
        )

        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "current_appointment": {
                "appointment_id": appointment.get("appointment_id"),
                "status": appointment.get("status"),
                "slot_id": appointment.get("slot_id"),
                "facility_id": facility_id,
                "dock_id": dock_id,
                "start_time": slot.get("start_time"),
                "end_time": slot.get("end_time"),
            },
            "dock": {
                "dock_id": dock_id,
                "staff_count": staff_count,
                "configuration": dock,
            },
            "queue": {
                "size": len(queue),
                "active_appointments": active_queue,
                "appointments": queue,
            },
            "capacity_events": active_capacity_events,
            "observed_wait_minutes": observed_wait,
            "reported_delay_minutes": reported_delay_minutes,
            "estimated_wait_minutes": estimated_wait,
            "projected_arrival": projected_arrival.isoformat() if projected_arrival else None,
            "projected_service_start": projected_service_start.isoformat() if projected_service_start else None,
            "appointment_window_missed": appointment_window_missed,
            "current_appointment_feasible": current_feasible,
            "feasibility_reasons": feasibility_reasons,
            "reschedule_required": reschedule_required,
            "capacity_signal": capacity_signal,
            "do_not_invent": "Staff count and wait time are reported only when supported by database data.",
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool("approve_reschedule", args_schema=ApproveRescheduleInput)
def approve_reschedule(shipment_id: str) -> str:
    """
    Record that the driver explicitly agreed to look for a replacement
    appointment after the agent explained the operational impact.

    This does not search, hold, or confirm a slot.
    """
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    state = TOOL_CONTEXT["session_manager"].get_state(
        TOOL_CONTEXT["conversation_id"]
    )
    analysis = state.get("facility_delay_analysis") or {}

    if not analysis.get("reschedule_required"):
        return json_dumps({
            "status": "not_ready",
            "message": "The current appointment has not been determined to require rescheduling.",
        })

    TOOL_CONTEXT["session_manager"].update(
        TOOL_CONTEXT["conversation_id"],
        shipment_id=shipment_id,
        workflow="reschedule_approved",
        current_step="reschedule_search_authorized",
        reschedule_approved=True,
    )

    return json_dumps({
        "status": "approved",
        "message": "Driver approved searching for a replacement appointment.",
    })


@tool(
    "check_slot_availability",
    args_schema=CheckSlotInput,
)
def check_slot_availability(
    shipment_id: str,
    after: Optional[str] = None,
) -> str:
    """
    Find currently available appointment slots.

    Availability comes directly from Supabase.
    The tool never invents slots.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    # For delay-driven rescheduling, a deterministic operational impact
    # analysis must run before slots can be offered.
    state = TOOL_CONTEXT["session_manager"].get_state(
        TOOL_CONTEXT["conversation_id"]
    )
    if state.get("workflow") in ("facility_delay", "reschedule_analysis", "delay_report", "reschedule_approved"):
        analysis = state.get("facility_delay_analysis") or {}
        if not analysis.get("reschedule_required"):
            return json_dumps({
                "status": "reschedule_not_yet_justified",
                "message": "Operational impact has not established that the current appointment is infeasible.",
            })
        if state.get("reschedule_approved") is not True:
            return json_dumps({
                "status": "driver_consent_required",
                "message": "The driver must explicitly approve searching for a replacement appointment first.",
            })

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    shipment = get_shipment(
        shipment_id
    )

    if not shipment:

        return json_dumps({
            "status": "not_found",
            "message": "Shipment was not found.",
        })

    try:

        if not after:
            after = now_iso()

        destination_id = shipment.get(
            "destination_id"
        )

        vehicle_id = shipment.get(
            "vehicle_id"
        )

        product_class = shipment.get(
            "product_class"
        )

        # --------------------------------------------------------
        # Vehicle lookup
        # --------------------------------------------------------

        vehicle_type = None

        if vehicle_id:

            vehicle_response = (
                supabase
                .table("vehicles")
                .select("*")
                .eq(
                    "vehicle_id",
                    vehicle_id,
                )
                .limit(1)
                .execute()
            )

            if vehicle_response.data:

                vehicle_type = (
                    vehicle_response.data[0]
                    .get("vehicle_type")
                )

        # --------------------------------------------------------
        # Determine facility
        #
        # Your existing DB sample uses facility_id on slots and
        # destination_id on shipments.
        # --------------------------------------------------------

        facility_id = destination_id

        if not facility_id:

            facility_id = shipment.get(
                "destination_facility_id"
            )

        # --------------------------------------------------------
        # Find docks
        # --------------------------------------------------------

        dock_query = (
            supabase
            .table("docks")
            .select("*")
            .eq(
                "active_flag",
                True,
            )
        )

        if facility_id:

            dock_query = dock_query.eq(
                "facility_id",
                facility_id,
            )

        docks_response = (
            dock_query.execute()
        )

        docks = (
            docks_response.data
            or []
        )

        compatible_docks = []

        for dock in docks:

            supported_vehicle_types = (
                dock.get(
                    "supported_vehicle_types"
                )
                or []
            )

            supported_product_classes = (
                dock.get(
                    "supported_product_classes"
                )
                or []
            )

            vehicle_ok = (
                not vehicle_type
                or vehicle_type
                in supported_vehicle_types
            )

            product_ok = (
                not product_class
                or product_class
                in supported_product_classes
            )

            if vehicle_ok and product_ok:

                compatible_docks.append(
                    dock
                )

        # --------------------------------------------------------
        # Slot query
        # --------------------------------------------------------

        slot_query = (
            supabase
            .table("appointment_slots")
            .select("*")
            .eq(
                "slot_status",
                "available",
            )
            .gte(
                "start_time",
                after,
            )
            .order(
                "start_time",
            )
            .limit(10)
        )

        if compatible_docks:

            dock_ids = [
                d.get("dock_id")
                for d in compatible_docks
                if d.get("dock_id")
            ]

            if dock_ids:

                slot_query = slot_query.in_(
                    "dock_id",
                    dock_ids,
                )

        elif facility_id:

            slot_query = slot_query.eq(
                "facility_id",
                facility_id,
            )

        response = (
            slot_query.execute()
        )

        slots = response.data or []

        # --------------------------------------------------------
        # Second-line conflict check.
        #
        # appointment_slots.slot_status is the primary availability
        # signal, but we also protect against stale slot state by
        # checking active appointments on the same dock.
        # Other drivers' confirmed/pending appointments are never
        # displaced. The current driver's own appointment is allowed
        # to be replaced only after the driver explicitly chooses a
        # new slot and the atomic confirmation RPC succeeds.
        # --------------------------------------------------------
        try:
            active_appointments = (
                supabase
                .table("appointments")
                .select("appointment_id,shipment_id,slot_id,status,appointment_slots(*)")
                .in_("status", ["pending", "confirmed"])
                .execute()
                .data
                or []
            )

            filtered_slots = []

            for candidate in slots:
                candidate_start = _parse_dt(candidate.get("start_time"))
                candidate_end = _parse_dt(candidate.get("end_time"))
                candidate_dock = candidate.get("dock_id")
                candidate_shipment = shipment_id
                conflict = False

                for appt in active_appointments:
                    if appt.get("shipment_id") == candidate_shipment:
                        continue

                    appt_slot = appt.get("appointment_slots") or {}
                    if appt_slot.get("dock_id") != candidate_dock:
                        continue

                    appt_start = _parse_dt(appt_slot.get("start_time"))
                    appt_end = _parse_dt(appt_slot.get("end_time"))

                    if not candidate_start or not candidate_end or not appt_start or not appt_end:
                        continue

                    if candidate_start < appt_end and candidate_end > appt_start:
                        conflict = True
                        break

                if not conflict:
                    filtered_slots.append(candidate)

            slots = filtered_slots

        except Exception as exc:
            # Do not hide a DB failure by pretending all slots are safe.
            print(f"[slot conflict check warning] {exc}")

        if not slots:

            TOOL_CONTEXT["session_manager"].update(
                TOOL_CONTEXT["conversation_id"],
                shipment_id=shipment_id,
                workflow="reschedule",
                current_step="no_slots",
            )

            return json_dumps({
                "status": "none_available",
                "message": "No available compatible slots were found.",
            })

        options = []

        for index, slot in enumerate(
            slots,
            start=1,
        ):

            option = {
                "option_number": index,
                "slot_id": slot.get(
                    "slot_id"
                ),
                "facility_id": slot.get(
                    "facility_id"
                ),
                "dock_id": slot.get(
                    "dock_id"
                ),
                "start_time": slot.get(
                    "start_time"
                ),
                "end_time": slot.get(
                    "end_time"
                ),
                "capacity_units": slot.get(
                    "capacity_units"
                ),
            }

            options.append(option)

        # Store the displayed options in Redis.
        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            shipment_id=shipment_id,
            workflow="reschedule",
            current_step="waiting_for_slot_selection",
            available_slots=options,
        )

        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "available_slots": options,
        })

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )


@tool(
    "hold_slot",
    args_schema=HoldSlotInput,
)
def hold_slot(
    slot_id: str,
    shipment_id: str,
    hold_seconds: int = DEFAULT_HOLD_SECONDS,
) -> str:
    """
    Atomically hold an available slot.

    ONLY the PostgreSQL RPC can reserve the slot.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:

        response = (
            supabase
            .rpc(
                "hold_slot_atomic",
                {
                    "p_slot_id": slot_id,
                    "p_driver_id": driver_id,
                    "p_shipment_id": shipment_id,
                    "p_hold_seconds": hold_seconds,
                },
            )
            .execute()
        )

        result = response.data

        if isinstance(
            result,
            list,
        ) and result:

            result = result[0]

        if not result:

            return json_dumps({
                "status": "error",
                "message": "Slot hold returned no result.",
            })

        if result.get("status") == "held":

            TOOL_CONTEXT["session_manager"].update(
                TOOL_CONTEXT["conversation_id"],
                shipment_id=shipment_id,
                workflow="reschedule",
                current_step="waiting_for_confirmation",
                selected_slot=slot_id,
                hold_until=result.get(
                    "held_until"
                ),
            )

        return json_dumps(
            result
        )

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )


@tool(
    "confirm_slot",
    args_schema=ConfirmSlotInput,
)
def confirm_slot(
    slot_id: str,
    shipment_id: str,
) -> str:
    """
    Confirm a previously held slot.

    The RPC verifies that the authenticated driver still
    owns the hold and that it has not expired.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:

        response = (
            supabase
            .rpc(
                "confirm_slot_atomic",
                {
                    "p_slot_id": slot_id,
                    "p_shipment_id": shipment_id,
                    "p_driver_id": driver_id,
                },
            )
            .execute()
        )

        result = response.data

        if isinstance(
            result,
            list,
        ) and result:

            result = result[0]

        if not result:

            return json_dumps({
                "status": "error",
                "message": "Slot confirmation returned no result.",
            })

        if result.get("status") == "confirmed":

            TOOL_CONTEXT["session_manager"].update(
                TOOL_CONTEXT["conversation_id"],
                shipment_id=shipment_id,
                workflow="appointment_confirmed",
                current_step="completed",
                selected_slot=slot_id,
                hold_until=None,
            )

        elif result.get("status") in (
            "expired_or_conflict",
            "conflict",
        ):

            TOOL_CONTEXT["session_manager"].update(
                TOOL_CONTEXT["conversation_id"],
                current_step="hold_failed",
                hold_until=None,
            )

        return json_dumps(
            result
        )

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )


@tool(
    "release_hold",
    args_schema=ReleaseHoldInput,
)
def release_hold(
    slot_id: str,
) -> str:
    """
    Release a pending slot hold.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    try:

        response = (
            supabase
            .rpc(
                "release_hold_atomic",
                {
                    "p_slot_id": slot_id,
                    "p_driver_id": driver_id,
                },
            )
            .execute()
        )

        result = response.data

        if isinstance(
            result,
            list,
        ) and result:

            result = result[0]

        if result and result.get(
            "status"
        ) == "released":

            TOOL_CONTEXT["session_manager"].update(
                TOOL_CONTEXT["conversation_id"],
                current_step="waiting_for_slot_selection",
                selected_slot=None,
                hold_until=None,
            )

        return json_dumps(
            result
            or {
                "status": "error",
                "message": "Release operation returned no result.",
            }
        )

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )


@tool(
    "escalate_to_human",
    args_schema=EscalateInput,
)
def escalate_to_human(
    shipment_id: str,
    reason: str,
) -> str:
    """
    Escalate a freight issue to human operations.

    This implementation uses driver_exceptions because that
    table is confirmed in the current project.
    """

    driver_id = TOOL_CONTEXT["driver_id"]

    if not shipment_belongs_to_driver(
        shipment_id,
        driver_id,
    ):

        return json_dumps({
            "status": "forbidden",
            "message": "Shipment does not belong to the authenticated driver.",
        })

    try:

        exception_id = generate_id(
            "EXC"
        )

        payload = {
            "exception_id": exception_id,
            "driver_id": driver_id,
            "shipment_id": shipment_id,
            "exception_type": "other",
            "reported_delay_minutes": 1,
            "status": "open",
        }

        response = (
            supabase
            .table("driver_exceptions")
            .insert(payload)
            .execute()
        )

        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            workflow="escalated",
            current_step="human_review",
            shipment_id=shipment_id,
        )

        return json_dumps({
            "status": "escalated",
            "exception_id": exception_id,
            "message": (
                "The operational issue has been escalated "
                "for human review."
            ),
            "data": response.data,
        })

    except Exception as exc:

        return json_dumps(
            db_error(exc)
        )



# ============================================================
# DRIVER AVAILABILITY / REASSIGNMENT
# ============================================================

@tool("set_driver_availability", args_schema=DriverAvailabilityInput)
def set_driver_availability(availability_status: str) -> str:
    """Update the authenticated driver's operational availability."""
    driver_id = TOOL_CONTEXT["driver_id"]
    status = availability_status.strip().lower()
    if status not in {"available", "unavailable", "on_trip"}:
        return json_dumps({"status": "invalid", "message": "Invalid availability status."})
    try:
        response = (supabase.table("drivers").update({"availability_status": status})
                    .eq("driver_id", driver_id).execute())
        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            driver_availability=status,
        )
        return json_dumps({
            "status": "success",
            "driver_id": driver_id,
            "availability_status": status,
            "data": response.data,
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool("find_available_drivers", args_schema=FindAvailableDriversInput)
def find_available_drivers(shipment_id: str, limit: int = 5) -> str:
    """Find operationally available replacement drivers without exposing private details."""
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({"status": "forbidden", "message": "Shipment does not belong to the authenticated driver."})
    try:
        response = (supabase.table("drivers")
                    .select("driver_id,name,status,availability_status")
                    .eq("status", "active")
                    .eq("availability_status", "available")
                    .neq("driver_id", driver_id)
                    .limit(limit)
                    .execute())
        candidates = response.data or []
        return json_dumps({
            "status": "success",
            "shipment_id": shipment_id,
            "available_drivers": candidates,
            "message": "Only operationally relevant driver information is returned. Private contact details are not exposed.",
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


@tool("request_driver_reassignment", args_schema=RequestDriverReassignmentInput)
def request_driver_reassignment(
    shipment_id: str,
    replacement_driver_id: str,
    reason: str,
) -> str:
    """Create a controlled reassignment request; never silently reassign another driver."""
    driver_id = TOOL_CONTEXT["driver_id"]
    if not shipment_belongs_to_driver(shipment_id, driver_id):
        return json_dumps({"status": "forbidden", "message": "Shipment does not belong to the authenticated driver."})
    if replacement_driver_id == driver_id:
        return json_dumps({"status": "invalid", "message": "Replacement driver must be different from the authenticated driver."})
    try:
        replacement = get_driver(replacement_driver_id)
        if not replacement:
            return json_dumps({"status": "not_found", "message": "Replacement driver was not found."})
        if str(replacement.get("status", "")).lower() != "active" or str(replacement.get("availability_status", "")).lower() != "available":
            return json_dumps({"status": "not_available", "message": "The selected driver is not currently available."})

        # We deliberately do not update shipments.driver_id here. This is a
        # controlled request because reassignment can affect appointment/vehicle state.
        request_id = generate_id("REASSIGN")
        TOOL_CONTEXT["session_manager"].update(
            TOOL_CONTEXT["conversation_id"],
            shipment_id=shipment_id,
            workflow="driver_reassignment",
            current_step="human_review",
            reassignment_request_id=request_id,
            replacement_driver_id=replacement_driver_id,
        )
        return json_dumps({
            "status": "requested",
            "request_id": request_id,
            "shipment_id": shipment_id,
            "replacement_driver_id": replacement_driver_id,
            "message": "Driver reassignment request created for operations review. The shipment has not been silently reassigned.",
            "reason": reason,
        })
    except Exception as exc:
        return json_dumps(db_error(exc))


# ============================================================
# TOOL REPOSITORY
# ============================================================

tools = [
    get_driver_shipments_tool,
    get_shipment_tool,
    get_current_eta,
    get_appointment_status,
    get_gate_entry_status,
    get_facility_operation_status,
    check_existing_open_exception,
    analyze_facility_delay,
    approve_reschedule,
    record_exception,
    record_eta_update,
    report_operational_state,
    report_warehouse_schedule,
    check_slot_availability,
    hold_slot,
    confirm_slot,
    release_hold,
    escalate_to_human,
    set_driver_availability,
    find_available_drivers,
    request_driver_reassignment,
]

tools_repo = {
    tool_function.name: tool_function
    for tool_function in tools
}


# ============================================================
# TOOL CONTEXT
# ============================================================

"""
The LLM must NEVER be trusted to supply the authenticated driver ID.

This application context is populated before each LLM invocation.
"""

TOOL_CONTEXT: Dict[str, Any] = {
    "driver_id": None,
    "conversation_id": None,
    "session_manager": session_manager,
}


def set_tool_context(
    driver_id: str,
    conversation_id: str,
):

    TOOL_CONTEXT["driver_id"] = driver_id

    TOOL_CONTEXT["conversation_id"] = (
        conversation_id
    )

    TOOL_CONTEXT["session_manager"] = (
        session_manager
    )


# ============================================================
# LLM
# ============================================================

llm = ChatOpenAI(
    base_url=OPENROUTER_BASE_URL,
    model=OPENROUTER_MODEL,
    temperature=0,
    api_key=OPEN_ROUTER_API_KEY,
)

# IMPORTANT:
# Tools are bound to the LLM.
tool_llm = llm.bind_tools(
    tools
)


# ============================================================
# SYSTEM PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are SetuHaul, an AI Freight Operations Assistant for an authenticated professional truck driver.

CORE PRINCIPLE
==============
UNDERSTAND -> VERIFY -> ANALYZE -> ACT -> CONFIRM
Never claim an operational action happened unless a tool returned success.

AUTHENTICATED DRIVER
====================
Authenticated driver: {driver_id}
The application verified Driver ID + registered mobile number.
Never change driver identity from chat text. Never access another driver's data.
If asked about another driver: "I can only provide information associated with your verified driver account."

REDIS
=====
Current Redis working state: {redis_state}
Redis is short-term workflow memory. Supabase/PostgreSQL is the operational source of truth.
Never treat Redis alone as proof of appointment confirmation.

NORMAL CONVERSATION
===================
Greetings, thanks, yes/no and general conversation do not require operational tools.

SHIPMENT IDENTIFICATION
=======================
If shipment is unknown, call get_driver_shipments. If exactly one active shipment exists, use it. If multiple exist, ask which one. Never guess.

CURRENT ETA
===========
For any question about an ETA, expected arrival, revised arrival, delivery time, delay outcome, or shipment status that includes ETA, call get_current_eta. Use its `current_eta_ist` display value when replying. Never use `planned_eta` from shipment details as the current ETA unless get_current_eta says `eta_source` is `planned_eta`.

THREE OPERATIONAL ISSUE BUCKETS
================================
1) DRIVER / VEHICLE: puncture, flat tire, breakdown, engine, overheating, battery, brakes, workshop repair, accident, illness, injury, fatigue, safety issue.
2) ROUTE / EXTERNAL: traffic, road accident, road closure, construction, diversion, flood, landslide, bridge closure, toll/checkpoint, police inspection, navigation, weather impact.
3) SHIPMENT / FACILITY: loading delay, unloading delay, waiting in parking, waiting for dock, dock congestion, facility queue, limited staff, dock unavailable, facility closed, gate/security, shipment not ready, documents, previous-stop delay, customer/facility delay.

NORMAL ACTIVITIES — NOT EXCEPTIONS
==================================
Tea, coffee, lunch, bathroom, normal refueling, normal planned rest, routine inspection and scheduled maintenance do not automatically create an exception or trigger rescheduling.
Rain by itself is not a delay. Rain becomes an exception only when it causes operational impact such as a meaningful ETA change, road closure or inability to continue.
Safety fatigue/illness/injury is a safety concern, not a routine break.

DELAY WORKFLOW
==============
When a driver reports a problem:
1. Identify shipment.
2. Identify bucket/category.
3. Determine whether it affects ETA/appointment.
4. Ask one concise question if critical information is missing.
5. Check existing open exception.
6. Create/update exception.
7. Record driver ETA when supplied.
8. Determine appointment impact.
9. Only if current appointment is infeasible should replacement slots be offered.

FACILITY / DOCK DELAY — MANDATORY WORKFLOW
===========================================
For statements such as:
- "I'm waiting in parking and they haven't called me."
- "I reached the bay but nobody is calling me."
- "They are taking too long to unload."
- "There are only two people unloading."

Do NOT immediately call check_slot_availability.

First:
1. Identify shipment.
2. Get current appointment/dock.
3. Check existing open exception.
4. Call analyze_facility_delay.
5. Use its returned dock, queue, staffing/capacity and appointment-impact facts.
6. If current appointment remains feasible, record the delay if appropriate and keep the appointment.
7. If current appointment is infeasible, explain why and ask whether the driver wants a replacement slot.
8. On explicit approval, call approve_reschedule.
9. Only after approve_reschedule succeeds, call check_slot_availability.

Never invent worker counts, queue sizes, dock status or estimated wait times.

APPOINTMENT IMPACT / CASCADE
===========================
A new slot must not displace another driver's confirmed appointment. Never cancel, move or modify another driver's appointment.
A candidate slot must be available, compatible, correct-facility, and non-conflicting according to the scheduling tool/database.
If moving this driver would require a cascade or there is no feasible slot, escalate to human operations.

Example:
Driver appointment = 9:00 PM. Driver arrives at bay 8:30 PM. At 9:02 PM they report they are still waiting.
The agent must inspect the assigned dock/facility and queue before proposing 9:30 PM. If the current dock cannot complete the service within the appointment window, explain the impact, ask permission to find a new slot, then search.

APPOINTMENT STATUS
==================
For current appointment, confirmation or dock questions, use get_appointment_status. Never infer confirmation from Redis alone.

GATE, DOCK, AND UNLOADING STATUS
=================================
For questions such as "Can I enter the gate?", "Am I approved?", "Which dock should I go to?", "Has the facility assigned me?", or "Has unloading started?", use the live gate/facility tools.
- Call get_gate_entry_status for gate pre-registration, security status, gate details, and the registered vehicle.
- Call get_facility_operation_status for the facility team's dock assignment and unloading progress.
- Never say a vehicle may enter unless get_gate_entry_status returns entry_allowed=true.
- A record with entry_status=expected only means pre-registration; it is not gate approval or physical check-in.
- Drivers cannot approve entry, assign a dock, start/complete unloading, or check themselves out. Those actions belong to facility/security staff.

RESCHEDULE CONSENT
==================
approve_reschedule records explicit driver consent to search for a replacement after operational impact analysis. It does not book anything.

SLOT AVAILABILITY
=================
check_slot_availability is the source of truth for slots that may be offered. In delay workflows it must only be called after operational impact analysis says the current appointment is infeasible, approve_reschedule succeeds, and the driver has agreed. Never invent a slot.

SLOT SELECTION / HOLD / CONFIRM
===============================
When driver selects a displayed slot, call hold_slot. A displayed slot is not reserved.
After successful hold, say it is temporarily held and ask whether to confirm.
Call confirm_slot only after explicit confirmation and only for the authenticated driver's valid active hold.
Never say confirmed unless confirm_slot succeeds.
If a hold conflicts/expires, explain it and offer current availability.

SAFETY
======
Driver safety comes before scheduling. For brake failure, dangerous vehicle condition, serious accident, medical emergency or unsafe fatigue, escalate when automated handling is not safe.

ESCALATION
==========
Escalate when no feasible slot exists, another driver's confirmed appointment would need to change, data conflicts, serious safety issues exist, driver asks for human help, or automation cannot safely proceed.



EXCEPTION DATA GUARD
====================
Never call record_exception unless shipment_id, issue_category and a positive reported_delay_minutes are known.
If the driver gives only a reason such as "flood", "sick", "puncture" or "traffic", ask for the expected delay or ETA before recording the exception. Never use 0 as a default.
Never calculate a revised ETA by adding a repair/delay duration to the planned ETA. After recording an issue, ask for the driver's revised arrival time and call record_eta_update only when they provide it.
A failed tool call is not success. Never say an exception, hold, confirmation, ETA update or reassignment happened unless the tool returned a success status.

LIVE OPERATIONS AND WAREHOUSE REPORTS
=====================================
When a driver says they are early and waiting, late and waiting, unloading, or have declared a revised ETA, call report_operational_state. When the driver relays a warehouse appointment time, call report_warehouse_schedule. If it returns schedule_conflict, call escalate_to_human; never overwrite the stored appointment from a warehouse report.

PRIORITY POLICY
===============
Confirmed appointments are never displaced. Priority can only be used to rank currently available, unheld options; it never cancels another driver's pending or confirmed appointment.

DRIVER ILLNESS / SAFETY
=======================
If the driver says they are sick, injured, fatigued or otherwise unable to continue, first ask whether they are safe and able to continue driving. Do not record a delay or reschedule solely from the word "sick".
If the driver cannot continue, mark the authenticated driver unavailable and use find_available_drivers. Never expose another driver's phone number or private information.

TRAVEL DELAY FEASIBILITY
========================
When a driver provides a delay such as 30 minutes, 90 minutes or 10 hours, pass the known delay to analyze_facility_delay when appointment impact must be assessed. The tool, not the LLM, determines appointment feasibility.
A 10-hour delay must not be described as feasible for a same-day evening appointment unless the operational tool explicitly calculates that it fits.

AFTER A REVISED ETA IS RECORDED
===============================
In the SAME driver turn after record_eta_update succeeds, do not end the conversation or ask a generic follow-up question. Call get_appointment_status, then call analyze_facility_delay with the driver-reported delay from Redis state when it is available.
If the analysis says reschedule_required=true, explain briefly that the current appointment cannot be met and ask one clear question: whether the driver wants you to search for a replacement slot. Do not search, hold, or confirm a slot until the driver explicitly agrees.
If the appointment remains feasible, state that result and keep the existing appointment. If there is no active appointment, state that clearly.

RESCHEDULE INTENT
=================
"I need a slot" or "I want a new slot" expresses intent, not necessarily explicit approval, unless the operational analysis has already established infeasibility and the driver clearly agrees to proceed. Never call approve_reschedule before impact analysis says reschedule_required=true.

ERRORS
======
Never expose SQL, Supabase, PostgreSQL, Redis internals, Python exceptions, PGRST codes, constraints, API keys or internal tool names. Translate tool results into operational language.

COMMUNICATION
=============
Be professional, calm, concise and human. Ask at most one question at a time. Do not ask for information already known.

TIME ZONE
=========
All driver-facing times must be stated in India Standard Time (IST, UTC+05:30) and labelled "IST". Tool results include both the stored UTC timestamp and a corresponding `*_ist` display value; use the `*_ist` value when speaking to the driver. Never present a bare time without its time zone.

FINAL CHECK
===========
Before answering: understand driver; verify shipment; use live tools when required; analyze impact before rescheduling; protect other appointments; never invent facts; confirm only successful operations.
"""


# ============================================================
# CHAT PERSISTENCE + REDIS LANGCHAIN HISTORY
# ============================================================

REDIS_CHAT_TTL = SESSION_TTL


def redis_chat_key(conversation_id: str) -> str:
    return f"setuhaul:chat:{conversation_id}"


def load_chat_history(
    conversation_id: str,
) -> InMemoryChatMessageHistory:
    """Load serialized LangChain messages from Redis, Sameer-style."""
    history = InMemoryChatMessageHistory()
    raw = redis_client.get(redis_chat_key(conversation_id))

    if raw:
        try:
            for message in messages_from_dict(json.loads(raw)):
                history.add_message(message)
            redis_client.expire(redis_chat_key(conversation_id), REDIS_CHAT_TTL)
            return history
        except Exception as exc:
            log.warning("Redis chat history could not be loaded: %s", exc)
            print(f"[Redis history load warning] {exc}")

    # Redis is hot memory. If it expired, rebuild from permanent Supabase
    # human/assistant history, then continue using Redis for the active turn.
    for row in get_conversation_messages(conversation_id):
        role = row.get("role")
        text = row.get("message", "")
        if not text:
            continue
        if role == "driver":
            history.add_user_message(text)
        elif role == "assistant":
            history.add_ai_message(text)

    return history


def save_chat_history(
    conversation_id: str,
    history: InMemoryChatMessageHistory,
):
    """Persist the full LangChain conversation/tool trace to Redis with TTL."""
    try:
        redis_client.set(
            redis_chat_key(conversation_id),
            json.dumps(
                messages_to_dict(history.messages),
                default=str,
            ),
            ex=REDIS_CHAT_TTL,
        )
    except Exception as exc:
        log.warning("Redis chat history could not be saved: %s", exc)
        print(f"[Redis history save warning] {exc}")


def create_conversation(
    conversation_id: str,
    driver_id: str,
) -> bool:
    try:
        existing = (supabase.table("chat_conversations")
                    .select("conversation_id")
                    .eq("conversation_id", conversation_id)
                    .limit(1).execute())
        if existing.data:
            return True
        supabase.table("chat_conversations").insert({
            "conversation_id": conversation_id,
            "driver_id": driver_id,
        }).execute()
        return True
    except Exception as exc:
        log.warning("Conversation persistence failed: %s", exc)
        print("[conversation persistence warning]", exc)
        return False


def save_message(
    conversation_id: str,
    driver_id: str,
    role: str,
    message: str,
    shipment_id: Optional[str] = None,
):
    """Permanent audit copy. Only DB-supported roles are written."""
    if role not in ("driver", "assistant"):
        return
    try:
        message_id = generate_id("MSG")
        supabase.table("chat_messages").insert({
            "message_id": message_id,
            "conversation_id": conversation_id,
            "driver_id": driver_id,
            "shipment_id": shipment_id,
            "role": role,
            "message": message,
            "idempotency_key": message_id,
            "created_at": now_iso(),
        }).execute()
    except Exception as exc:
        log.warning("Message persistence failed: %s", exc)
        print("[message persistence warning]", exc)


def get_conversation_messages(
    conversation_id: str,
    limit: int = MAX_HISTORY_MESSAGES,
) -> List[Dict[str, Any]]:
    try:
        response = (supabase.table("chat_messages")
                    .select("role,message,created_at,shipment_id")
                    .eq("conversation_id", conversation_id)
                    .order("created_at", desc=True)
                    .limit(limit).execute())
        rows = response.data or []
        rows.reverse()
        return rows
    except Exception as exc:
        print("[history load warning]", exc)
        return []


# ============================================================
# LANGCHAIN CHAIN + CONTROLLED TOOL LOOP
# ============================================================

prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        SYSTEM_PROMPT,
    ),
    MessagesPlaceholder(variable_name="messages"),
])

# Core LangChain step. This is the same prompt -> tool-bound LLM pattern.
core_chain = prompt | tool_llm


MAX_TOOL_ITERATIONS = 8


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts).strip()
    return str(content).strip()
def _tool_error_message(
    tool_name: str,
    tool_call_id: str,
    message: str,
) -> ToolMessage:
    """Return a valid LangChain tool result for recoverable tool failures."""
    return ToolMessage(
        content=json_dumps({
            "status": "error",
            "message": message,
        }),
        tool_call_id=tool_call_id,
        name=tool_name,
        status="error",
    )


def execute_tool_call(tool_call: Dict[str, Any]) -> ToolMessage:
    """Execute one model-requested tool without breaking the message protocol."""
    tool_name = tool_call.get("name")
    # OpenAI-compatible providers normally call this ``id``. Keep a fallback
    # for providers that expose it as ``tool_call_id`` or omit it entirely.
    tool_call_id = (
        tool_call.get("id")
        or tool_call.get("tool_call_id")
        or generate_id("TOOLCALL")
    )
    tool_args = tool_call.get("args") or {}

    # Do not log user-provided values: they can contain phone numbers or other
    # operationally sensitive data. Argument names are enough for diagnosis.
    log.info(
        "TOOL START | name=%s | call_id=%s | argument_keys=%s",
        tool_name,
        tool_call_id,
        sorted(tool_args.keys()),
    )

    tool = tools_repo.get(tool_name)

    if tool is None:
        log.error("TOOL FAILED | name=%s | reason=tool_not_registered", tool_name)
        return _tool_error_message(
            tool_name or "unknown_tool",
            tool_call_id,
            "The requested operation is unavailable.",
        )

    try:
        result = tool.invoke(tool_args)

        log.info(
            "TOOL SUCCESS | name=%s | result_type=%s",
            tool_name,
            type(result).__name__,
        )
        _log_message_block("TOOL_RESULT", {
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "arguments": tool_args,
            "result": result,
        })

        return ToolMessage(
            content=result if isinstance(result, str)
                    else json_dumps(result),
            tool_call_id=tool_call_id,
            name=tool_name,
        )

    except Exception as exc:
        # Keep implementation details out of the model/driver response but
        # preserve them in the console for diagnosis.
        log.exception("Tool execution failed: %s", tool_name)
        print(f"[tool error] {tool_name}: {exc}")
        return _tool_error_message(
            tool_name,
            tool_call_id,
            "The requested operation could not be completed.",
        )

def tool_loop(
    ai_response: AIMessage,
    history: InMemoryChatMessageHistory,
    driver_id: str,
    conversation_id: str,
) -> AIMessage:
    """Sameer-style while response.tool_calls loop, with SetuHaul guards."""
    response = ai_response
    iteration = 0
    _log_ai_message("initial_model_response", response)

    while response.tool_calls:
        iteration += 1
        print(f"[LangChain] tool cycle {iteration}/{MAX_TOOL_ITERATIONS}")

        if iteration > MAX_TOOL_ITERATIONS:
            return AIMessage(
                content=(
                    "I couldn't complete that operation safely. "
                    "Please try again."
                )
            )

        history.add_message(response)

        for tool_call in response.tool_calls:
            tool_message = execute_tool_call(tool_call)
            _log_message_block("TOOL_MESSAGE", {
                "tool_name": tool_message.name,
                "tool_call_id": tool_message.tool_call_id,
                "status": tool_message.status,
                "content": tool_message.content,
            })
            history.add_message(tool_message)

        # Refresh workflow state after tools and run the actual LangChain
        # prompt -> LLM chain again with the complete message history.
        set_tool_context(driver_id, conversation_id)
        state = session_manager.get_state(conversation_id)

        response = core_chain.invoke({
            "driver_id": driver_id,
            "redis_state": json_dumps(state),
            "messages": history.messages,
        })
        _log_ai_message(f"model_response_after_tool_cycle_{iteration}", response)

    history.add_message(response)
    return response


def build_turn_chain(
    history: InMemoryChatMessageHistory,
    driver_id: str,
    conversation_id: str,
):
    """Build the explicit LangChain chain: prompt | llm_with_tools | RunnableLambda."""
    return (
        prompt
        | tool_llm
        | RunnableLambda(
            lambda ai_response: tool_loop(
                ai_response,
                history,
                driver_id,
                conversation_id,
            )
        )
    )


def invoke_agent(
    driver_id: str,
    conversation_id: str,
    user_message: str,
) -> str:
    log.debug("Invoking agent: driver=%s conversation=%s", driver_id, conversation_id)
    _log_message_block("DRIVER_MESSAGE", {
        "driver_id": driver_id,
        "conversation_id": conversation_id,
        "content": user_message,
    })
    set_tool_context(driver_id, conversation_id)

    state = session_manager.get_state(conversation_id)
    if state:
        if state.get("driver_id") and state.get("driver_id") != driver_id:
            raise PermissionError("Authenticated driver does not match the active session.")
        if state.get("authenticated") is not True:
            raise PermissionError("Driver session is not authenticated.")

    if not state:
        conversation_id = session_manager.get_or_create(driver_id)
        state = session_manager.get_state(conversation_id)
        create_conversation(conversation_id, driver_id)
        set_tool_context(driver_id, conversation_id)

    history = load_chat_history(conversation_id)
    history.add_user_message(user_message)

    # Explicit LangChain chain invocation.
    print("[LangChain] chain.invoke()")
    turn_chain = build_turn_chain(
        history,
        driver_id,
        conversation_id,
    )

    response = turn_chain.invoke({
        "driver_id": driver_id,
        "redis_state": json_dumps(state),
        "messages": history.messages,
    })

    save_chat_history(conversation_id, history)

    final_response = _extract_text(response.content)
    _log_message_block("FINAL_RESPONSE", {
        "driver_id": driver_id,
        "conversation_id": conversation_id,
        "content": final_response,
    })
    return final_response


# ============================================================
# UPDATE REDIS AFTER EACH TURN
# ============================================================

def update_session_from_response(
    conversation_id: str,
    driver_id: str,
    user_message: str,
    assistant_message: str,
):

    state = session_manager.get_state(
        conversation_id
    )

    # If tools already updated workflow state,
    # preserve it.

    current_step = state.get(
        "current_step"
    )

    # Basic conversational activity tracking.
    session_manager.update(
        conversation_id,
        last_activity=now_iso(),
    )

    # Keep driver identity authoritative.
    session_manager.update(
        conversation_id,
        driver_id=driver_id,
    )

    # Do not change workflow based on keywords.
    # Tool calls are responsible for operational state.


# ============================================================
# START NEW DRIVER SESSION
# ============================================================

def start_driver_session(
    driver_id: str,
) -> Optional[str]:

    driver_id = (
        driver_id
        .strip()
        .upper()
    )

    if not driver_id:

        return None

    # --------------------------------------------------------
    # Validate driver against Supabase
    # --------------------------------------------------------

    driver = get_driver(
        driver_id
    )

    if not driver:

        return None

    # --------------------------------------------------------
    # Redis session
    # --------------------------------------------------------

    conversation_id = (
        session_manager.get_or_create(
            driver_id
        )
    )

    # --------------------------------------------------------
    # Persist conversation
    # --------------------------------------------------------

    persistence_ok = (
        create_conversation(
            conversation_id,
            driver_id,
        )
    )

    if not persistence_ok:

        print(
            "\nWARNING: Conversation could not be "
            "persisted to Supabase."
        )

        print(
            "The chat can continue, but message "
            "history will not be permanently stored.\n"
        )

    session_manager.update(
        conversation_id,
        driver_id=driver_id,
        authenticated=True,
        mobile_verified=True,
        auth_method="driver_id_and_registered_phone",
    )

    return conversation_id


# ============================================================
# CLI
# ============================================================

def main():

    log.info("SetuHaul agent CLI started.")

    print(
        "\n"
        "======================================================================\n"
        " SETUHAUL FREIGHT OPERATIONS ASSISTANT\n"
        "======================================================================\n"
    )

    # --------------------------------------------------------
    # Redis
    # --------------------------------------------------------

    if not check_redis():

        print(
            "Redis is required for active session management."
        )

        return

    # --------------------------------------------------------
    # Driver authentication
    # --------------------------------------------------------
    # Authentication is performed by application code, not by the LLM.
    # Driver ID + registered mobile number are required.

    driver_id = authenticate_driver()

    if not driver_id:
        return

    conversation_id = start_driver_session(
        driver_id
    )

    if not conversation_id:
        print("\nUnable to start the authenticated driver session.")
        return

    # --------------------------------------------------------
    # Session information
    # --------------------------------------------------------

    authenticated_state = session_manager.get_state(
        conversation_id
    )

    if (
        authenticated_state.get("driver_id") != driver_id
        or authenticated_state.get("authenticated") is not True
        or authenticated_state.get("mobile_verified") is not True
    ):
        print("\nUnable to establish a secure authenticated driver session.")
        return

    print(
        f"\nDriver session: {driver_id}"
    )

    print(
        f"Conversation: {conversation_id}"
    )

    print(
        "Type 'exit' to stop.\n"
    )

    print(
        "SetuHaul: Hi! I'm your SetuHaul freight "
        "operations assistant. How can I help you today?\n"
    )

    # --------------------------------------------------------
    # Initial greeting persistence
    # --------------------------------------------------------

    greeting = (
        "Hi! I'm your SetuHaul freight operations "
        "assistant. How can I help you today?"
    )

    save_message(
        conversation_id=conversation_id,
        driver_id=driver_id,
        role="assistant",
        message=greeting,
    )

    # Seed Redis with the same LangChain history model used by the agent.
    greeting_history = load_chat_history(conversation_id)
    if not greeting_history.messages:
        greeting_history.add_ai_message(greeting)
        save_chat_history(conversation_id, greeting_history)

    # --------------------------------------------------------
    # Chat loop
    # --------------------------------------------------------

    while True:

        try:

            user_input = input(
                "Driver: "
            ).strip()

            if not user_input:

                continue

            if user_input.lower() in (
                "exit",
                "quit",
            ):

                print(
                    "\nSetuHaul: Goodbye. Drive safe."
                )

                break

            # ------------------------------------------------
            # Redis activity refresh
            # ------------------------------------------------

            session_manager.update(
                conversation_id,
                last_activity=now_iso(),
            )

            # ------------------------------------------------
            # Determine shipment context BEFORE persistence
            # ------------------------------------------------

            state = (
                session_manager.get_state(
                    conversation_id
                )
            )

            shipment_id = state.get(
                "shipment_id"
            )

            # ------------------------------------------------
            # Save driver message
            # ------------------------------------------------

            save_message(
                conversation_id=conversation_id,
                driver_id=driver_id,
                role="driver",
                message=user_input,
                shipment_id=shipment_id,
            )

            # ------------------------------------------------
            # LLM + LangChain + tools
            # ------------------------------------------------

            try:

                assistant_reply = invoke_agent(
                    driver_id=driver_id,
                    conversation_id=conversation_id,
                    user_message=user_input,
                )

            except Exception as exc:

                print(
                    f"\n[LLM error] {exc}"
                )

                assistant_reply = (
                    "I'm having trouble connecting to "
                    "the freight operations service right now. "
                    "Please try again."
                )

            # ------------------------------------------------
            # Save assistant response
            # ------------------------------------------------

            state = (
                session_manager.get_state(
                    conversation_id
                )
            )

            shipment_id = state.get(
                "shipment_id"
            )

            save_message(
                conversation_id=conversation_id,
                driver_id=driver_id,
                role="assistant",
                message=assistant_reply,
                shipment_id=shipment_id,
            )

            # ------------------------------------------------
            # Redis update
            # ------------------------------------------------

            update_session_from_response(
                conversation_id=conversation_id,
                driver_id=driver_id,
                user_message=user_input,
                assistant_message=assistant_reply,
            )

            # ------------------------------------------------
            # Output
            # ------------------------------------------------

            print(
                f"\nSetuHaul: {assistant_reply}\n"
            )

        except KeyboardInterrupt:

            print(
                "\n\nSetuHaul: Session ended. Drive safe."
            )

            break

        except Exception as exc:

            print(
                f"\n[Application error] {exc}\n"
            )


# ============================================================
# FUNCTION-LEVEL TROUBLESHOOTING TRACE
# ============================================================

def _trace_function(function, qualified_name=None):
    """Log application function entry, successful completion, and failures.

    Inputs and return values are deliberately omitted because they may include
    driver contact details or operationally sensitive shipment information.
    """
    name = qualified_name or function.__qualname__

    @wraps(function)
    def traced(*args, **kwargs):
        log.info("FUNCTION START | %s", name)
        try:
            result = function(*args, **kwargs)
        except Exception:
            log.exception("FUNCTION FAILED | %s", name)
            raise
        log.info("FUNCTION SUCCESS | %s | result_type=%s", name, type(result).__name__)
        return result

    return traced


def _enable_function_tracing():
    """Instrument only operational functions; omit noisy formatting helpers."""
    traced_functions = {
        "check_redis",
        "get_driver",
        "validate_driver",
        "verify_driver_phone",
        "authenticate_driver",
        "get_shipment",
        "get_driver_shipments",
        "shipment_belongs_to_driver",
        "get_current_appointment",
        "calculate_updated_eta",
        "persist_eta_update",
        "db_error",
        "load_chat_history",
        "save_chat_history",
        "create_conversation",
        "save_message",
        "get_conversation_messages",
        "set_tool_context",
        "execute_tool_call",
        "tool_loop",
        "build_turn_chain",
        "invoke_agent",
        "update_session_from_response",
        "start_driver_session",
        "main",
    }
    traced_session_methods = {
        "get_or_create",
        "update",
        "clear_workflow",
        "delete_session",
    }

    for name in traced_functions:
        value = globals().get(name)
        if inspect.isfunction(value) and value.__module__ == __name__:
            globals()[name] = _trace_function(value, name)

    for name in traced_session_methods:
        value = getattr(SessionManager, name, None)
        if inspect.isfunction(value):
            setattr(SessionManager, name, _trace_function(value, f"SessionManager.{name}"))

    log.info("Operational troubleshooting trace enabled; formatting helpers are excluded.")


_enable_function_tracing()


# ============================================================
# AWS LAMBDA / AGENTCORE EXPORTS
# ============================================================

def log_chat_message(
    thread_id: str,
    shipment_id: Optional[str],
    role: str,
    message: str,
):
    """
    Persist a chat message for AWS Lambda / AgentCore.
    
    Maps to save_message() for Supabase persistence.
    thread_id is used as conversation_id.
    driver_id must be extracted from session state.
    """
    try:
        state = session_manager.get_state(thread_id)
        driver_id = state.get("driver_id") if state else None
        
        if not driver_id:
            # Fallback: try to get from TOOL_CONTEXT
            driver_id = TOOL_CONTEXT.get("driver_id")
        
        if driver_id:
            save_message(
                conversation_id=thread_id,
                driver_id=driver_id,
                role=role,
                message=message,
                shipment_id=shipment_id,
            )
    except Exception as exc:
        log.warning("log_chat_message failed: %s", exc)
        print(f"[log_chat_message warning] {exc}")


async def _setuhaul_dispatch_async(input_data: Dict[str, Any]) -> AIMessage:
    """
    Async dispatch for AWS Lambda / AgentCore.
    
    Input keys:
    - request_id (str): conversation/thread ID
    - message (str): user message
    - chat_history (str): optional context (unused; Redis is source of truth)
    
    Returns AIMessage with response content.
    """
    try:
        request_id = input_data.get("request_id") or input_data.get("thread_id")
        message = input_data.get("message")
        
        if not request_id or not message:
            error_msg = "Missing required fields: request_id and message"
            log.error("dispatch_async validation failed: %s", error_msg)
            return AIMessage(content=error_msg)
        
        # invoke_agent is synchronous; run it in thread pool to avoid blocking
        loop = None
        try:
            import asyncio
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        
        if loop:
            # We're in an async context; run invoke_agent in executor
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                # Extract driver_id from session state
                state = session_manager.get_state(request_id)
                driver_id = state.get("driver_id") if state else None
                
                if not driver_id:
                    error_msg = "Driver session not found or not authenticated."
                    return AIMessage(content=error_msg)
                
                response_text = await loop.run_in_executor(
                    executor,
                    invoke_agent,
                    driver_id,
                    request_id,
                    message,
                )
        else:
            # Direct call if not in async context
            state = session_manager.get_state(request_id)
            driver_id = state.get("driver_id") if state else None
            
            if not driver_id:
                error_msg = "Driver session not found or not authenticated."
                return AIMessage(content=error_msg)
            
            response_text = invoke_agent(
                driver_id=driver_id,
                conversation_id=request_id,
                user_message=message,
            )
        
        return AIMessage(content=response_text)
    
    except Exception as exc:
        log.exception("dispatch_async failed: %s", exc)
        error_response = "An error occurred processing your request."
        return AIMessage(content=error_response)


# LangChain Runnable for AWS Lambda
setuhaul_dispatch_chain = RunnableLambda(_setuhaul_dispatch_async)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":

    main()
