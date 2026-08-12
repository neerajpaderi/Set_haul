"""
SetuHaul — Pydantic Schemas & Enums
=====================================
Single source of truth for every enum and pydantic model used by the
agent's tools. Keep this in sync with the Supabase schema:

  - appointment_slots.slot_status : available | held | booked
  - driver_exceptions.exception_type : traffic_delay | mechanical_breakdown | weather | other
  - driver_exceptions.status : open | resolved
  - shipments.status : planned | in_transit | arrived | completed | cancelled
  - appointments.status (DB enum `appointment_status`) : pending | confirmed | cancelled | superseded
    NOTE: appointments.status is written only inside the Postgres RPC functions
    (hold_slot_atomic / confirm_slot_atomic / release_hold_atomic), never
    directly from Python — so it is not modeled as a write model here.
"""

import uuid
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


# =====================================================================
# ENUMS — must mirror Supabase column definitions
# =====================================================================

class SlotStatusEnum(str, Enum):
    AVAILABLE = "available"
    HELD = "held"
    BOOKED = "booked"


class ExceptionTypeEnum(str, Enum):
    TRAFFIC_DELAY = "traffic_delay"
    MECHANICAL_BREAKDOWN = "mechanical_breakdown"
    WEATHER = "weather"
    OTHER = "other"


class ExceptionStatusEnum(str, Enum):
    OPEN = "open"
    RESOLVED = "resolved"


class ShipmentStatusEnum(str, Enum):
    PLANNED = "planned"
    IN_TRANSIT = "in_transit"
    ARRIVED = "arrived"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class AppointmentStatusEnum(str, Enum):
    """Mirrors the Postgres enum `appointment_status`. Provided for reference /
    response typing only — Python never writes this column directly; the
    RPC functions in migration_v2.sql own all transitions."""
    PENDING = "pending"
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"
    SUPERSEDED = "superseded"


# =====================================================================
# DB WRITE VALIDATION MODELS
# (used by tools that insert/update rows directly, not via RPC)
# =====================================================================

class DriverExceptionWriteModel(BaseModel):
    exception_id: str = Field(default_factory=lambda: f"EXC-{uuid.uuid4().hex[:6].upper()}")
    driver_id: str = Field(..., description="Must be a valid Driver ID like DRV-101")
    shipment_id: str = Field(..., description="Must be a valid Shipment ID like SHP-1001")
    exception_type: ExceptionTypeEnum = ExceptionTypeEnum.TRAFFIC_DELAY
    reported_delay_minutes: int = Field(..., ge=1, le=1440, description="Delay duration in minutes")
    status: ExceptionStatusEnum = ExceptionStatusEnum.OPEN


class EtaUpdateWriteModel(BaseModel):
    eta_update_id: str = Field(default_factory=lambda: f"ETA-{uuid.uuid4().hex[:8].upper()}")
    shipment_id: str
    declared_eta: str = Field(..., description="ISO 8601 timestamp")
    source_type: Literal["driver", "ops"] = "driver"
    confidence_note: Optional[str] = None


# =====================================================================
# TOOL INPUT SCHEMAS
# =====================================================================

class GetDriverShipmentDetailsInput(BaseModel):
    identifier: str = Field(description="Driver ID or Shipment ID, e.g. DRV-101 or SHP-1001")


class CheckExistingExceptionInput(BaseModel):
    shipment_id: str = Field(description="Shipment ID to check for an already-open exception")


class RecordExceptionInput(BaseModel):
    driver_id: str
    shipment_id: str
    exception_type: ExceptionTypeEnum = ExceptionTypeEnum.TRAFFIC_DELAY
    reported_delay_minutes: int = Field(..., ge=1, le=1440)
    existing_exception_id: Optional[str] = Field(
        default=None,
        description=(
            "If check_existing_open_exception found an open one, pass its id here "
            "to UPDATE it instead of inserting a duplicate."
        ),
    )


class RecordEtaUpdateInput(BaseModel):
    shipment_id: str
    declared_eta: str = Field(description="ISO 8601 timestamp, e.g. 2026-08-13T20:30:00+00:00")
    confidence_note: Optional[str] = None


class CheckSlotAvailabilityInput(BaseModel):
    shipment_id: str = Field(description="Used to derive destination facility, vehicle type and product class")
    after: str = Field(description="Only return slots starting at or after this ISO timestamp")


class HoldSlotInput(BaseModel):
    slot_id: str
    driver_id: str
    shipment_id: str
    hold_seconds: int = 180


class ConfirmSlotInput(BaseModel):
    slot_id: str
    shipment_id: str
    driver_id: str


class ReleaseHoldInput(BaseModel):
    slot_id: str
    driver_id: str


class GetAppointmentStatusInput(BaseModel):
    shipment_id: str


class EscalateInput(BaseModel):
    shipment_id: str
    driver_id: str
    reason: str = Field(description="Why this needs a human: no feasible slot, contradictory info, safety, etc.")