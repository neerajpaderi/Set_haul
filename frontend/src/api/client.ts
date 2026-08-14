import {
  AppointmentSlotOption,
  DriverProfile,
  ExceptionType,
  IssueReport,
  Shipment,
  ShipmentStatus,
} from '../types';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request to ${path} failed (${res.status})`);
  }
  return res.json();
}

export function getDriverProfile(driverId: string) {
  return request<DriverProfile>(`/api/drivers/${driverId}`);
}

export function getActiveShipment(driverId: string) {
  return request<Shipment | null>(`/api/shipments/active/${driverId}`);
}

export function getShipmentHistory(driverId: string) {
  return request<Shipment[]>(`/api/shipments/history/${driverId}`);
}

export function updateShipmentStatus(shipmentId: string, status: ShipmentStatus) {
  return request<Shipment>(`/api/shipments/${shipmentId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function reportIssue(shipmentId: string, category: ExceptionType, estimatedDelayMinutes: number) {
  return request<IssueReport>(`/api/shipments/${shipmentId}/exceptions`, {
    method: 'POST',
    body: JSON.stringify({ category, estimatedDelayMinutes }),
  });
}

export function resolveIssue(exceptionId: string) {
  return request<IssueReport>(`/api/exceptions/${exceptionId}/resolve`, { method: 'PATCH' });
}

export function getBookableSlots(shipmentId: string, driverId: string) {
  return request<AppointmentSlotOption[]>(`/api/shipments/${shipmentId}/slots?driverId=${encodeURIComponent(driverId)}`);
}

export interface HoldSlotResult {
  status: 'held' | 'conflict';
  slot_id?: string;
  held_until?: string;
  message?: string;
}

export function holdSlot(slotId: string, driverId: string, shipmentId: string) {
  return request<HoldSlotResult>(`/api/slots/${slotId}/hold`, {
    method: 'POST',
    body: JSON.stringify({ driverId, shipmentId }),
  });
}

export interface ConfirmSlotResult {
  status: 'confirmed' | 'expired_or_conflict';
  slot_id?: string;
  message?: string;
}

export function confirmSlot(slotId: string, driverId: string, shipmentId: string) {
  return request<ConfirmSlotResult>(`/api/slots/${slotId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ driverId, shipmentId }),
  });
}

export interface ReleaseSlotResult {
  status: 'released' | 'not_held';
  slot_id?: string;
  message?: string;
}

export function releaseSlot(slotId: string, driverId: string) {
  return request<ReleaseSlotResult>(`/api/slots/${slotId}/release`, {
    method: 'POST',
    body: JSON.stringify({ driverId }),
  });
}
