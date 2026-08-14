"""
SetuHaul Driver Exception & Dock Slot Coordination Agent
=========================================================
Run migration_v2.sql in Supabase BEFORE running this script.

Architecture:
  - The LLM is the conversational layer only. It never decides availability,
    priority, or double-booking outcomes — those are enforced by atomic
    Postgres RPC functions (hold_slot_atomic / confirm_slot_atomic /
    release_hold_atomic).
  - All writes go through pydantic-validated tool inputs (schema.py).
  - Every driver/assistant message is persisted to chat_messages so a
    driver can return later and ask "what's my status".
"""

import os
import json
import uuid
from typing import Optional, List

from dotenv import load_dotenv
from supabase import create_client, Client
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from model.load import get_api_key
from schema import (
    ExceptionTypeEnum,
    DriverExceptionWriteModel,
    EtaUpdateWriteModel,
    GetDriverShipmentDetailsInput,
    CheckExistingExceptionInput,
    RecordExceptionInput,
    RecordEtaUpdateInput,
    CheckSlotAvailabilityInput,
    HoldSlotInput,
    ConfirmSlotInput,
    ReleaseHoldInput,
    GetAppointmentStatusInput,
    EscalateInput,
)

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = get_api_key("sethaul_supabase_api_key", "SUPABASE_KEY")
OPEN_ROUTER_API_KEY = get_api_key("sethaul_open_router_api_key", "OPEN_ROUTER_API_KEY")

if not SUPABASE_URL:
    raise ValueError("Missing SUPABASE_URL in .env file.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def handle_db_error(e: Exception) -> str:
    err_str = str(e)
    print(f"\n[SUPABASE DB EXCEPTION]: {err_str}\n")
    return json.dumps({"status": "error", "message": f"Database operation failed: {err_str}"})


# =====================================================================
# TOOLS — READ
# =====================================================================

@tool("get_driver_shipment_details", args_schema=GetDriverShipmentDetailsInput)
def get_driver_shipment_details(identifier: str) -> str:
    """Look up the active shipment for a driver or shipment ID. Returns a list — if more than one
    active shipment is found, the caller must ask the driver to disambiguate rather than guessing."""
    try:
        clean_id = str(identifier).strip()
        res = (
            supabase.table("shipments")
            .select("*")
            .or_(f"shipment_id.eq.{clean_id},driver_id.eq.{clean_id}")
            .not_.in_("status", ["completed", "cancelled"])
            .execute()
        )
        rows = res.data
        if not rows:
            return json.dumps({"status": "not_found", "message": f"No active shipment found for '{clean_id}'."})

        candidates = [{
            "shipment_id": r.get("shipment_id"),
            "driver_id": r.get("driver_id"),
            "vehicle_id": r.get("vehicle_id"),
            "destination_id": r.get("destination_id"),
            "product_class": r.get("product_class"),
            "priority": r.get("priority"),
            "planned_eta": r.get("planned_eta"),
            "expected_unload_minutes": r.get("expected_unload_minutes"),
            "status": r.get("status"),
        } for r in rows]

        if len(candidates) > 1:
            return json.dumps({"status": "ambiguous", "candidates": candidates})

        return json.dumps({"status": "success", "data": candidates[0]})
    except Exception as e:
        return handle_db_error(e)


@tool("check_existing_open_exception", args_schema=CheckExistingExceptionInput)
def check_existing_open_exception(shipment_id: str) -> str:
    """Checks whether an open (unresolved) exception already exists for this shipment, to avoid
    inserting duplicate exception rows when a driver retries or resends the same message."""
    try:
        res = (
            supabase.table("driver_exceptions")
            .select("*")
            .eq("shipment_id", shipment_id)
            .eq("status", "open")
            .order("reported_at", desc=True)
            .limit(1)
            .execute()
        )
        if not res.data:
            return json.dumps({"status": "none_open"})
        return json.dumps({"status": "open_exists", "exception": res.data[0]})
    except Exception as e:
        return handle_db_error(e)


@tool("check_slot_availability", args_schema=CheckSlotAvailabilityInput)
def check_slot_availability(shipment_id: str, after: str) -> str:
    """Finds feasible AVAILABLE slots for a shipment: enforces dock/vehicle-type/product-class
    compatibility and facility match. Never returns held or booked slots. This is the only
    source of truth for what a driver may be offered."""
    try:
        ship_res = supabase.table("shipments").select("*").eq("shipment_id", shipment_id).limit(1).execute()
        if not ship_res.data:
            return json.dumps({"status": "not_found", "message": f"Shipment {shipment_id} not found."})
        ship = ship_res.data[0]

        veh_res = supabase.table("vehicles").select("*").eq("vehicle_id", ship["vehicle_id"]).limit(1).execute()
        if not veh_res.data:
            return json.dumps({"status": "error", "message": "Vehicle record not found for shipment."})
        vehicle_type = veh_res.data[0]["vehicle_type"]
        product_class = ship["product_class"]

        docks_res = (
            supabase.table("docks")
            .select("*")
            .eq("facility_id", ship["destination_id"])
            .eq("active_flag", True)
            .execute()
        )
        compatible_dock_ids = [
            d["dock_id"] for d in docks_res.data
            if vehicle_type in (d.get("supported_vehicle_types") or [])
            and product_class in (d.get("supported_product_classes") or [])
        ]
        if not compatible_dock_ids:
            return json.dumps({
                "status": "no_compatible_dock",
                "message": f"No active dock at {ship['destination_id']} supports {vehicle_type} / {product_class}."
            })

        slots_res = (
            supabase.table("appointment_slots")
            .select("*")
            .in_("dock_id", compatible_dock_ids)
            .eq("slot_status", "available")
            .gte("start_time", after)
            .order("start_time")
            .limit(5)
            .execute()
        )
        if not slots_res.data:
            return json.dumps({"status": "none_available", "message": "No feasible slots found after the given time."})

        options = [{
            "slot_id": s["slot_id"],
            "dock_id": s["dock_id"],
            "facility_id": s["facility_id"],
            "start_time": s["start_time"],
            "end_time": s["end_time"],
        } for s in slots_res.data]

        return json.dumps({"status": "success", "available_slots": options})
    except Exception as e:
        return handle_db_error(e)


@tool("get_appointment_status", args_schema=GetAppointmentStatusInput)
def get_appointment_status(shipment_id: str) -> str:
    """Returns the current appointment (pending or confirmed) for a shipment, if any, by reading
    the appointments link table — not by guessing from timestamps."""
    try:
        res = (
            supabase.table("appointments")
            .select("*, appointment_slots(*)")
            .eq("shipment_id", shipment_id)
            .in_("status", ["pending", "confirmed"])
            .order("booked_at", desc=True)
            .limit(1)
            .execute()
        )
        if not res.data:
            return json.dumps({"status": "no_active_appointment"})
        row = res.data[0]
        slot = row.get("appointment_slots") or {}
        return json.dumps({
            "status": "success",
            "appointment_status": row["status"],
            "slot_id": row["slot_id"],
            "dock_id": slot.get("dock_id"),
            "start_time": slot.get("start_time"),
            "end_time": slot.get("end_time"),
            "confirmed_at": row.get("confirmed_at"),
        })
    except Exception as e:
        return handle_db_error(e)


# =====================================================================
# TOOLS — WRITE (validated via schema.py)
# =====================================================================

@tool("record_exception", args_schema=RecordExceptionInput)
def record_exception(driver_id: str, shipment_id: str, exception_type: ExceptionTypeEnum,
                      reported_delay_minutes: int, existing_exception_id: Optional[str] = None) -> str:
    """Records a driver-reported exception. If existing_exception_id is provided (from
    check_existing_open_exception), UPDATES that row instead of inserting a duplicate."""
    try:
        if existing_exception_id:
            res = (
                supabase.table("driver_exceptions")
                .update({
                    "exception_type": exception_type.value,
                    "reported_delay_minutes": reported_delay_minutes,
                })
                .eq("exception_id", existing_exception_id)
                .execute()
            )
            return json.dumps({"status": "success", "message": "Updated existing open exception.", "data": res.data})

        validated = DriverExceptionWriteModel(
            driver_id=driver_id,
            shipment_id=shipment_id,
            exception_type=exception_type,
            reported_delay_minutes=reported_delay_minutes,
        )
        res = supabase.table("driver_exceptions").insert(validated.model_dump()).execute()
        return json.dumps({"status": "success", "message": "New exception recorded.", "data": res.data})
    except ValueError as ve:
        return json.dumps({"status": "validation_error", "message": str(ve)})
    except Exception as e:
        return handle_db_error(e)


@tool("record_eta_update", args_schema=RecordEtaUpdateInput)
def record_eta_update(shipment_id: str, declared_eta: str, confidence_note: Optional[str] = None) -> str:
    """Appends a driver-declared ETA to the eta_updates history. Always additive — never
    overwrites prior declared ETAs, preserving the audit trail."""
    try:
        validated = EtaUpdateWriteModel(
            shipment_id=shipment_id,
            declared_eta=declared_eta,
            source_type="driver",
            confidence_note=confidence_note,
        )
        res = supabase.table("eta_updates").insert(validated.model_dump()).execute()
        return json.dumps({"status": "success", "data": res.data})
    except ValueError as ve:
        return json.dumps({"status": "validation_error", "message": str(ve)})
    except Exception as e:
        return handle_db_error(e)


@tool("hold_slot", args_schema=HoldSlotInput)
def hold_slot(slot_id: str, driver_id: str, shipment_id: str, hold_seconds: int = 180) -> str:
    """Atomically holds a slot for a shipment via the Postgres RPC hold_slot_atomic. Fails with
    status=conflict if another active hold or booking already exists on the slot. This is the
    ONLY way a slot may be reserved — never mark a slot booked directly."""
    try:
        res = supabase.rpc("hold_slot_atomic", {
            "p_slot_id": slot_id,
            "p_driver_id": driver_id,
            "p_shipment_id": shipment_id,
            "p_hold_seconds": hold_seconds,
        }).execute()
        return json.dumps(res.data)
    except Exception as e:
        return handle_db_error(e)


@tool("confirm_slot", args_schema=ConfirmSlotInput)
def confirm_slot(slot_id: str, shipment_id: str, driver_id: str) -> str:
    """Atomically confirms a previously held slot via the Postgres RPC confirm_slot_atomic.
    Verifies the hold still belongs to this driver and has not expired before committing.
    Also supersedes this shipment's prior confirmed slot, correctly scoped — never touches
    other shipments' bookings."""
    try:
        res = supabase.rpc("confirm_slot_atomic", {
            "p_slot_id": slot_id,
            "p_shipment_id": shipment_id,
            "p_driver_id": driver_id,
        }).execute()
        return json.dumps(res.data)
    except Exception as e:
        return handle_db_error(e)


@tool("release_hold", args_schema=ReleaseHoldInput)
def release_hold(slot_id: str, driver_id: str) -> str:
    """Releases an active hold early via the Postgres RPC release_hold_atomic, e.g. when the
    driver changes their mind before confirming."""
    try:
        res = supabase.rpc("release_hold_atomic", {
            "p_slot_id": slot_id,
            "p_driver_id": driver_id,
        }).execute()
        return json.dumps(res.data)
    except Exception as e:
        return handle_db_error(e)


@tool("escalate_to_human", args_schema=EscalateInput)
def escalate_to_human(shipment_id: str, driver_id: str, reason: str) -> str:
    """Flags this case for a human operations coordinator. Use when there is no feasible slot,
    information is contradictory, or the situation involves driver safety, penalties, or
    anything outside automated authority. Never invent a workaround instead of calling this."""
    try:
        supabase.table("driver_exceptions").insert({
            "exception_id": f"EXC-ESC-{uuid.uuid4().hex[:6].upper()}",
            "driver_id": driver_id,
            "shipment_id": shipment_id,
            "exception_type": "other",
            "reported_delay_minutes": 1,  # placeholder; real detail lives in reason/chat log
            "status": "open",
        }).execute()
        print(f"\n[ESCALATION] shipment={shipment_id} driver={driver_id} reason={reason}\n")
        return json.dumps({
            "status": "escalated",
            "message": "A human operations coordinator has been notified and will follow up.",
        })
    except Exception as e:
        return handle_db_error(e)


# =====================================================================
# TOOLS LIST, REPO & MODEL BINDING
# =====================================================================

tools = [
    get_driver_shipment_details,
    check_existing_open_exception,
    record_exception,
    record_eta_update,
    check_slot_availability,
    hold_slot,
    confirm_slot,
    release_hold,
    get_appointment_status,
    escalate_to_human,
]

tools_repo = {t.name: t for t in tools}

llm = ChatOpenAI(
    base_url="https://openrouter.ai/api/v1",
    model="google/gemini-2.5-flash",
    temperature=0,
    api_key=OPEN_ROUTER_API_KEY,
)
tool_llm = llm.bind_tools(tools)


def run_tool_loop(response, max_iters: int = 8):
    messages = [response]
    iters = 0
    while getattr(response, "tool_calls", None) and iters < max_iters:
        for tool_call in response.tool_calls:
            tool_fn = tools_repo.get(tool_call["name"])
            if tool_fn is None:
                tool_message = {
                    "role": "tool",
                    "content": json.dumps({"status": "error", "message": f"Unknown tool {tool_call['name']}"}),
                    "tool_call_id": tool_call["id"],
                }
            else:
                tool_message = tool_fn.invoke(tool_call)
                print("Tool reponse: {tool_message}")
            messages.append(tool_message)
        response = tool_llm.invoke(messages)
        print("Response: {response}")
        messages.append(response)
        iters += 1
    return response


SYSTEM_PROMPT = """You are SetuHaul's driver exception assistant. You talk with truck drivers
about delivery delays and dock appointments.

You have NO knowledge of shipments, ETAs, exceptions, or dock availability except what tools
return in THIS conversation. Never state a slot, ETA, or status you have not just retrieved
from a tool this turn — data goes stale fast and other drivers may be changing it concurrently.

WORKFLOW RULES:
1. Identify the shipment first via get_driver_shipment_details. If status="ambiguous", list the
   candidates and ask the driver which shipment they mean. Never guess.
2. When a driver reports a delay, ALWAYS call check_existing_open_exception first. If one is
   already open for this shipment, pass its exception_id into record_exception as
   existing_exception_id so it gets updated, not duplicated. This applies even if the driver's
   wording is slightly different from their last message.
3. Always call record_eta_update whenever the driver gives or implies a revised arrival time,
   even if no slot change happens yet.
4. To offer slots, call check_slot_availability with shipment_id (not facility_id) — it derives
   vehicle/product/dock compatibility internally. Never suggest a time the tool did not return.
5. Showing a slot is NOT reserving it. Only call hold_slot when the driver clearly chooses one
   option. Tell the driver it is held and until when (from the tool's held_until).
6. Only call confirm_slot after a successful hold_slot call in this same flow. If confirm_slot
   returns status "expired_or_conflict", say so plainly and immediately re-run
   check_slot_availability — do not assume the old slot is still theirs.
7. If the driver wants to cancel a pending hold or changes their mind before confirming, call
   release_hold.
8. If check_slot_availability returns "none_available" or "no_compatible_dock", or if any
   information is contradictory, call escalate_to_human with a clear reason. Never invent a
   workaround, promise capacity that wasn't returned by a tool, or make safety/penalty/commercial
   decisions yourself.
9. For "has it been confirmed?" or status follow-ups, call get_appointment_status.
10. Ask only for information you do not already have from tool results or the conversation so
    far. Ask at most one question per turn. Keep replies short, plain, and specific to what just
    happened — no filler.
11. Ask the user again for a valid query politely if the user diverts from the above rules or asks
    something you cannot answer.
"""

prompt = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_PROMPT),
    ("human", "Request ID: {request_id}\n\nChat History:\n{chat_history}\n\nLatest Driver Message:\n{message}"),
])

setuhaul_dispatch_chain = prompt | tool_llm | RunnableLambda(run_tool_loop)


# =====================================================================
# CHAT LOGGING (so a driver can return later and ask for status)
#
# `sender_type` is a DB enum whose exact labels we don't want to hard-guess
# again. On first failure for a given logical role ("driver"/"assistant"),
# we try a short list of common alternatives and CACHE whichever one the
# DB actually accepts, so we only ever pay the guessing cost once per
# process, not on every message.
# =====================================================================

_SENDER_TYPE_CANDIDATES = {
    "driver": ["driver", "user", "human"],
    "assistant": ["assistant", "agent", "bot", "system", "ai", "dispatcher"],
}
_resolved_sender_type: dict[str, str] = {}


def _insert_chat_message(thread_id: str, exception_id: Optional[str], sender_type_value: str, text: str) -> None:
    supabase.table("chat_messages").insert({
        "message_id": f"MSG-{uuid.uuid4().hex[:8].upper()}",
        "thread_id": thread_id,
        "exception_id": exception_id,
        "sender_type": sender_type_value,
        "message_text": text,
    }).execute()


def log_chat_message(thread_id: str, exception_id: Optional[str], role: str, text: str) -> None:
    """role is the logical role ("driver" or "assistant"); the DB-accepted
    literal is resolved (and cached) against _SENDER_TYPE_CANDIDATES."""
    if role in _resolved_sender_type:
        try:
            _insert_chat_message(thread_id, exception_id, _resolved_sender_type[role], text)
            return
        except Exception as e:
            print(f"[chat log warning] cached sender_type '{_resolved_sender_type[role]}' stopped working: {e}")
            del _resolved_sender_type[role]

    candidates = _SENDER_TYPE_CANDIDATES.get(role, [role])
    last_error = None
    for candidate in candidates:
        try:
            _insert_chat_message(thread_id, exception_id, candidate, text)
            _resolved_sender_type[role] = candidate
            return
        except Exception as e:
            last_error = e
            continue

    print(f"[chat log warning] no working sender_type found for role '{role}': {last_error}")
    print("  -> run this in Supabase SQL editor and tell me the output, I will hardcode it:")
    print("     select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid")
    print("     where t.typname = (select udt_name from information_schema.columns")
    print("       where table_name='chat_messages' and column_name='sender_type');")


# =====================================================================
# INTERACTIVE CLI LOOP
# =====================================================================

if __name__ == "__main__":
    request_id = f"REQ-{uuid.uuid4().hex[:6].upper()}"
    thread_id = f"TH-{uuid.uuid4().hex[:6].upper()}"
    chat_history_list: List[str] = []

    print(f"\nSetuHaul Dispatch Assistant Initialized (Session: {request_id})")
    print("Type your message below as a driver. Type 'exit' to quit.\n")

    while True:
        try:
            user_input = input("Driver: ").strip()
            if not user_input:
                continue
            if user_input.lower() in ["exit", "quit"]:
                print("Exiting chat session.")
                break

            log_chat_message(thread_id, None, "driver", user_input)
            history_str = "\n".join(chat_history_list)

            result = setuhaul_dispatch_chain.invoke({
                "request_id": request_id,
                "chat_history": history_str,
                "message": user_input,
            })

            agent_reply = result.content
            print(f"\nDispatcher: {agent_reply}\n")

            log_chat_message(thread_id, None, "assistant", agent_reply)
            chat_history_list.append(f"Driver: {user_input}")
            chat_history_list.append(f"Dispatcher: {agent_reply}")

        except KeyboardInterrupt:
            print("\nSession interrupted. Exiting.")
            break
        except Exception as e:
            print(f"\nError: {str(e)}\n")