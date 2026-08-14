import { supabase } from './supabaseClient';

// Confirmed real Postgres enum values (via PostgREST OpenAPI schema) — keep
// in sync with src/types.ts.
export const SHIPMENT_STATUSES = ['planned', 'in_transit', 'arrived', 'completed', 'cancelled'] as const;
export const EXCEPTION_TYPES = ['breakdown', 'traffic_delay', 'late_departure', 'accident', 'other'] as const;
const TERMINAL_SHIPMENT_STATUSES = ['completed', 'cancelled'];

function computeProgress(status: string, checkin: any | null): number {
  if (status === 'completed') return 100;
  if (checkin?.completed_at) return 100;
  if (checkin?.dock_in_at) return 75;
  if (checkin?.gate_in_at) return 50;
  if (status === 'in_transit' || status === 'arrived') return 33;
  return 0; // planned / cancelled
}

function issueTitle(category: string) {
  switch (category) {
    case 'breakdown': return 'Truck Breakdown / Mechanical';
    case 'traffic_delay': return 'Traffic Delay / Congestion';
    case 'late_departure': return 'Late Departure from Origin';
    case 'accident': return 'Accident / Collision';
    default: return 'Other Incident';
  }
}

// Fetches a shipment plus everything needed to shape it into the UI's
// trimmed Shipment type, including a server-assembled timeline merged from
// every timestamped table that touches the shipment (the DB stores
// structured facts, not display-ready copy, so the text here is generated
// at read time).
export async function buildShipmentView(shipmentId: string) {
  const { data: shipment, error: shipmentErr } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .maybeSingle();
  if (shipmentErr) throw shipmentErr;
  if (!shipment) return null;

  const [
    { data: vehicle },
    { data: destFacility },
    { data: appointments },
    { data: exceptions },
    { data: etaUpdates },
    { data: checkins },
  ] = await Promise.all([
    supabase.from('vehicles').select('*').eq('vehicle_id', shipment.vehicle_id).maybeSingle(),
    supabase.from('facilities').select('*').eq('facility_id', shipment.destination_id).maybeSingle(),
    supabase
      .from('appointments')
      .select('*, appointment_slots(start_time, end_time)')
      .eq('shipment_id', shipmentId)
      .order('booked_at', { ascending: false }),
    supabase.from('driver_exceptions').select('*').eq('shipment_id', shipmentId).order('reported_at', { ascending: false }),
    supabase.from('eta_updates').select('*').eq('shipment_id', shipmentId).order('declared_at', { ascending: false }),
    supabase.from('facility_checkins').select('*').eq('shipment_id', shipmentId),
  ]);

  const checkin = checkins?.[0] ?? null;
  const liveAppointment = (appointments ?? []).find((a) => a.status === 'pending' || a.status === 'confirmed') ?? null;
  const latestEta = (etaUpdates ?? [])[0] ?? null;

  const destLabel = destFacility ? `${destFacility.name} (${destFacility.city})` : shipment.destination_id;

  const timeline: any[] = [
    {
      id: `TL-CREATED-${shipment.shipment_id}`,
      timestamp: shipment.created_at,
      status: 'planned',
      title: 'Shipment Planned',
      description: `${shipment.product_class} cargo planned from ${shipment.origin_id} to ${destLabel}.`,
      location: shipment.origin_id,
      author: 'SYSTEM',
    },
  ];

  if (checkin?.gate_in_at) {
    timeline.push({
      id: `TL-GATE-${checkin.checkin_id}`,
      timestamp: checkin.gate_in_at,
      status: 'arrived',
      title: 'Gate Check-In',
      description: `Arrival status: ${checkin.arrival_status}, queue status: ${checkin.queue_status}.`,
      location: destLabel,
      author: 'SYSTEM',
    });
  }
  if (checkin?.dock_in_at) {
    timeline.push({
      id: `TL-DOCK-${checkin.checkin_id}`,
      timestamp: checkin.dock_in_at,
      status: 'arrived',
      title: 'Moved to Dock',
      description: `Dock-in recorded at ${destLabel}.`,
      location: destLabel,
      author: 'SYSTEM',
    });
  }
  if (checkin?.completed_at) {
    timeline.push({
      id: `TL-DONE-${checkin.checkin_id}`,
      timestamp: checkin.completed_at,
      status: 'completed',
      title: 'Unloading Completed',
      description: `Shipment completed at ${destLabel}.`,
      location: destLabel,
      author: 'SYSTEM',
    });
  }

  for (const e of etaUpdates ?? []) {
    timeline.push({
      id: `TL-ETA-${e.eta_update_id}`,
      timestamp: e.declared_at,
      status: shipment.status,
      title: 'ETA Updated',
      description: e.confidence_note
        ? `New ETA ${e.declared_eta} — ${e.confidence_note}`
        : `New ETA ${e.declared_eta} (source: ${e.source_type}).`,
      location: destLabel,
      author: e.source_type === 'driver' ? 'DRIVER' : 'DISPATCH',
    });
  }

  for (const exc of exceptions ?? []) {
    timeline.push({
      id: `TL-ISS-${exc.exception_id}`,
      timestamp: exc.reported_at,
      status: 'ISSUE_REPORTED',
      title: `Issue Reported: ${issueTitle(exc.exception_type)}`,
      description: `Estimated delay +${exc.reported_delay_minutes} minutes. Status: ${exc.status.replace('_', ' ')}.`,
      location: shipment.origin_id,
      author: 'DRIVER',
      issueId: exc.exception_id,
    });
  }

  for (const appt of appointments ?? []) {
    if (appt.booked_at) {
      timeline.push({
        id: `TL-APT-BOOKED-${appt.appointment_id}`,
        timestamp: appt.booked_at,
        status: shipment.status,
        title: 'Dock Appointment Held',
        description: `Appointment ${appt.appointment_id} held for slot ${appt.slot_id}.`,
        location: destLabel,
        author: 'DRIVER',
      });
    }
    if (appt.confirmed_at) {
      timeline.push({
        id: `TL-APT-CONFIRMED-${appt.appointment_id}`,
        timestamp: appt.confirmed_at,
        status: shipment.status,
        title: 'Dock Appointment Confirmed',
        description: `Appointment ${appt.appointment_id} confirmed for slot ${appt.slot_id}.`,
        location: destLabel,
        author: 'DRIVER',
      });
    }
    if (appt.cancelled_at) {
      timeline.push({
        id: `TL-APT-CANCELLED-${appt.appointment_id}`,
        timestamp: appt.cancelled_at,
        status: shipment.status,
        title: 'Dock Appointment Cancelled',
        description: `Appointment ${appt.appointment_id} cancelled.`,
        location: destLabel,
        author: 'DRIVER',
      });
    }
  }

  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    id: shipment.shipment_id,
    driverId: shipment.driver_id,
    vehicle: vehicle
      ? {
          id: vehicle.vehicle_id,
          type: vehicle.vehicle_type,
          lengthFt: vehicle.length_ft,
          refrigerationRequired: vehicle.refrigeration_required,
          status: vehicle.status,
        }
      : null,
    originLabel: shipment.origin_id,
    destinationFacility: destFacility
      ? { id: destFacility.facility_id, name: destFacility.name, city: destFacility.city }
      : { id: shipment.destination_id, name: shipment.destination_id, city: '' },
    productClass: shipment.product_class,
    priority: shipment.priority,
    plannedEta: shipment.planned_eta,
    expectedUnloadMinutes: shipment.expected_unload_minutes,
    status: shipment.status,
    currentProgressPercent: computeProgress(shipment.status, checkin),
    appointment: liveAppointment
      ? {
          id: liveAppointment.appointment_id,
          slotId: liveAppointment.slot_id,
          status: liveAppointment.status,
          startTime: liveAppointment.appointment_slots?.start_time,
          endTime: liveAppointment.appointment_slots?.end_time,
        }
      : null,
    latestEtaUpdate: latestEta
      ? {
          declaredEta: latestEta.declared_eta,
          sourceType: latestEta.source_type,
          confidenceNote: latestEta.confidence_note ?? undefined,
        }
      : null,
    waypoints: [
      {
        name: shipment.origin_id,
        type: 'PICKUP',
        completed: shipment.status !== 'planned',
      },
      {
        name: destLabel,
        type: 'DELIVERY',
        estimatedArrival: shipment.planned_eta,
        actualArrival: checkin?.completed_at ?? undefined,
        completed: shipment.status === 'completed',
      },
    ],
    issues: (exceptions ?? []).map((exc) => ({
      id: exc.exception_id,
      shipmentId: exc.shipment_id,
      category: exc.exception_type,
      estimatedDelayMinutes: exc.reported_delay_minutes,
      timestamp: exc.reported_at,
      status: exc.status,
    })),
    timeline,
    createdAt: shipment.created_at,
    completedAt: checkin?.completed_at ?? undefined,
  };
}

export function isTerminalStatus(status: string) {
  return TERMINAL_SHIPMENT_STATUSES.includes(status);
}
