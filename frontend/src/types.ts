// These unions mirror the real Postgres enums in the SetuHaul Supabase
// project exactly (confirmed via the PostgREST OpenAPI schema) — do not
// add values here without adding them to the DB enum first.
export type ShipmentStatus = 'planned' | 'in_transit' | 'arrived' | 'completed' | 'cancelled';
export type ExceptionType = 'breakdown' | 'traffic_delay' | 'late_departure' | 'accident' | 'other';
export type ExceptionStatus = 'open' | 'awaiting_driver' | 'awaiting_facility' | 'resolved' | 'escalated' | 'cancelled';
export type DriverStatus = 'active' | 'off_duty' | 'inactive';
export type VehicleStatus = 'active' | 'maintenance' | 'inactive';
export type SlotStatus = 'available' | 'held' | 'requested' | 'confirmed' | 'expired' | 'released' | 'blocked' | 'booked';
export type AppointmentStatus = 'pending' | 'confirmed' | 'cancelled' | 'superseded';

export interface IssueReport {
  id: string;
  shipmentId: string;
  category: ExceptionType;
  estimatedDelayMinutes: number;
  timestamp: string;
  status: ExceptionStatus;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  status: ShipmentStatus | 'ISSUE_REPORTED' | 'ISSUE_RESOLVED' | 'NOTE_ADDED';
  title: string;
  description: string;
  location: string;
  author: 'DRIVER' | 'DISPATCH' | 'SYSTEM';
  issueId?: string;
}

export interface Waypoint {
  name: string;
  type: 'PICKUP' | 'DELIVERY';
  estimatedArrival?: string;
  actualArrival?: string;
  completed: boolean;
}

export interface VehicleInfo {
  id: string; // vehicle_id
  type: string; // vehicle_type
  lengthFt: number;
  refrigerationRequired: boolean;
  status: VehicleStatus;
}

export interface AppointmentInfo {
  id: string; // appointment_id
  slotId: string;
  status: AppointmentStatus;
  startTime: string;
  endTime: string;
}

export interface Shipment {
  id: string; // shipment_id, e.g. SHP-1001
  driverId: string; // driver_id, e.g. DRV-101
  vehicle: VehicleInfo;

  originLabel: string; // raw origin_id (a hub label, not a facilities row)
  destinationFacility: {
    id: string; // facility_id
    name: string;
    city: string;
  };

  productClass: string;
  priority: number;
  plannedEta: string; // ISO timestamp
  expectedUnloadMinutes: number;

  status: ShipmentStatus;
  currentProgressPercent: number; // discrete stage (0/33/50/75/100), not GPS-derived
  appointment: AppointmentInfo | null;
  latestEtaUpdate: {
    declaredEta: string;
    sourceType: 'planned' | 'driver' | 'ops';
    confidenceNote?: string;
  } | null;

  waypoints: Waypoint[];
  issues: IssueReport[];
  timeline: TimelineEvent[];

  createdAt: string;
  completedAt?: string; // facility_checkins.completed_at, only set once status='completed'
}

export interface AppointmentSlotOption {
  slotId: string;
  dockId: string;
  dockName: string;
  facilityId: string;
  startTime: string;
  endTime: string;
  capacityUnits: number;
  slotStatus: SlotStatus;
  heldUntil?: string | null;
}

export interface DriverProfile {
  id: string; // driver_id
  name: string;
  phone: string;
  carrierId: string;
  homeBase: string;
  status: DriverStatus;
  assignedVehicle: VehicleInfo | null;
}
