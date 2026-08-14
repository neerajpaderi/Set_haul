import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { supabase } from './supabaseClient';
import { buildShipmentView, SHIPMENT_STATUSES, EXCEPTION_TYPES } from './shipmentShaping';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      console.error(err);
      // Postgres constraint violations (e.g. an enum value the DB doesn't
      // accept) come back as a PostgrestError with a `code`, not a generic
      // 500 — surface those as a clear 400 instead of crashing.
      const isConstraintViolation = typeof err?.code === 'string' && err.code.startsWith('23');
      res.status(isConstraintViolation ? 400 : 500).json({ error: err?.message || 'Unexpected server error' });
    });
  };
}

export function registerRoutes(app: Express) {
  app.get(
    '/api/drivers/:driverId',
    asyncHandler(async (req, res) => {
      const { driverId } = req.params;
      const { data: driver, error } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
      if (error) throw error;
      if (!driver) return void res.status(404).json({ error: `Driver ${driverId} not found` });

      const { data: recentShipments } = await supabase
        .from('shipments')
        .select('vehicle_id')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(1);

      let assignedVehicle = null;
      if (recentShipments?.[0]) {
        const { data: vehicle } = await supabase
          .from('vehicles')
          .select('*')
          .eq('vehicle_id', recentShipments[0].vehicle_id)
          .maybeSingle();
        if (vehicle) {
          assignedVehicle = {
            id: vehicle.vehicle_id,
            type: vehicle.vehicle_type,
            lengthFt: vehicle.length_ft,
            refrigerationRequired: vehicle.refrigeration_required,
            status: vehicle.status,
          };
        }
      }

      res.json({
        id: driver.driver_id,
        name: driver.name,
        phone: driver.phone,
        carrierId: driver.carrier_id,
        homeBase: driver.home_base,
        status: driver.status,
        assignedVehicle,
      });
    })
  );

  app.get(
    '/api/shipments/active/:driverId',
    asyncHandler(async (req, res) => {
      const { driverId } = req.params;
      const { data: rows, error } = await supabase
        .from('shipments')
        .select('shipment_id')
        .eq('driver_id', driverId)
        .not('status', 'in', '(completed,cancelled)')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      if (!rows?.length) return void res.json(null);
      res.json(await buildShipmentView(rows[0].shipment_id));
    })
  );

  app.get(
    '/api/shipments/history/:driverId',
    asyncHandler(async (req, res) => {
      const { driverId } = req.params;
      const { data: rows, error } = await supabase
        .from('shipments')
        .select('shipment_id')
        .eq('driver_id', driverId)
        .in('status', ['completed', 'cancelled'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      const views = await Promise.all((rows ?? []).map((r) => buildShipmentView(r.shipment_id)));
      res.json(views.filter(Boolean));
    })
  );

  app.patch(
    '/api/shipments/:shipmentId/status',
    asyncHandler(async (req, res) => {
      const { shipmentId } = req.params;
      const { status } = req.body;
      if (!SHIPMENT_STATUSES.includes(status)) {
        return void res.status(400).json({ error: `status must be one of: ${SHIPMENT_STATUSES.join(', ')}` });
      }
      const { error } = await supabase.from('shipments').update({ status }).eq('shipment_id', shipmentId);
      if (error) throw error;
      res.json(await buildShipmentView(shipmentId));
    })
  );

  app.post(
    '/api/shipments/:shipmentId/exceptions',
    asyncHandler(async (req, res) => {
      const { shipmentId } = req.params;
      const { category, estimatedDelayMinutes } = req.body;
      if (!EXCEPTION_TYPES.includes(category)) {
        return void res.status(400).json({ error: `category must be one of: ${EXCEPTION_TYPES.join(', ')}` });
      }

      const { data: shipment } = await supabase.from('shipments').select('driver_id').eq('shipment_id', shipmentId).maybeSingle();
      if (!shipment) return void res.status(404).json({ error: `Shipment ${shipmentId} not found` });

      const { data, error } = await supabase
        .from('driver_exceptions')
        .insert({
          exception_id: randomUUID(),
          driver_id: shipment.driver_id,
          shipment_id: shipmentId,
          exception_type: category,
          reported_delay_minutes: estimatedDelayMinutes,
          status: 'open',
        })
        .select()
        .single();
      if (error) throw error;

      res.json({
        id: data.exception_id,
        shipmentId: data.shipment_id,
        category: data.exception_type,
        estimatedDelayMinutes: data.reported_delay_minutes,
        timestamp: data.reported_at,
        status: data.status,
      });
    })
  );

  app.patch(
    '/api/exceptions/:exceptionId/resolve',
    asyncHandler(async (req, res) => {
      const { exceptionId } = req.params;
      const { data, error } = await supabase
        .from('driver_exceptions')
        .update({ status: 'resolved' })
        .eq('exception_id', exceptionId)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return void res.status(404).json({ error: `Exception ${exceptionId} not found` });
      res.json({
        id: data.exception_id,
        shipmentId: data.shipment_id,
        category: data.exception_type,
        estimatedDelayMinutes: data.reported_delay_minutes,
        timestamp: data.reported_at,
        status: data.status,
      });
    })
  );

  // Compatible, currently-bookable dock slots at a shipment's destination
  // facility — filters on dock<->vehicle/product-class compatibility, since
  // the hold/confirm RPCs don't enforce that themselves. A slot this driver
  // is already holding (even past appointment_slots.held_until, since
  // sweep_expired_holds() isn't cron-wired) is surfaced with its real state
  // so the client can show a countdown or an "expired" prompt.
  app.get(
    '/api/shipments/:shipmentId/slots',
    asyncHandler(async (req, res) => {
      const { shipmentId } = req.params;
      const driverId = typeof req.query.driverId === 'string' ? req.query.driverId : undefined;

      const { data: shipment } = await supabase
        .from('shipments')
        .select('destination_id, vehicle_id, product_class')
        .eq('shipment_id', shipmentId)
        .maybeSingle();
      if (!shipment) return void res.status(404).json({ error: `Shipment ${shipmentId} not found` });

      const { data: vehicle } = await supabase.from('vehicles').select('vehicle_type').eq('vehicle_id', shipment.vehicle_id).maybeSingle();

      const { data: docks } = await supabase
        .from('docks')
        .select('*')
        .eq('facility_id', shipment.destination_id)
        .eq('active_flag', true);

      const compatibleDocks = (docks ?? []).filter(
        (d) =>
          (d.supported_vehicle_types ?? []).includes(vehicle?.vehicle_type) &&
          (d.supported_product_classes ?? []).includes(shipment.product_class)
      );
      if (!compatibleDocks.length) return void res.json([]);

      const { data: slots } = await supabase
        .from('appointment_slots')
        .select('*')
        .in(
          'dock_id',
          compatibleDocks.map((d) => d.dock_id)
        )
        .order('start_time', { ascending: true });

      const now = Date.now();
      const options = (slots ?? [])
        .map((s) => {
          const heldExpired = s.slot_status === 'held' && s.held_until && new Date(s.held_until).getTime() < now;
          const effectiveStatus = heldExpired ? 'available' : s.slot_status;
          return { ...s, effectiveStatus };
        })
        .filter((s) => s.effectiveStatus === 'available' || (s.effectiveStatus === 'held' && driverId && s.held_by === driverId))
        .map((s) => ({
          slotId: s.slot_id,
          dockId: s.dock_id,
          dockName: compatibleDocks.find((d) => d.dock_id === s.dock_id)?.dock_name ?? s.dock_id,
          facilityId: s.facility_id,
          startTime: s.start_time,
          endTime: s.end_time,
          capacityUnits: s.capacity_units,
          slotStatus: s.effectiveStatus,
          heldUntil: s.effectiveStatus === 'held' ? s.held_until : null,
        }));

      res.json(options);
    })
  );

  // These RPCs are invoker-rights, not SECURITY DEFINER (see db_details.sql).
  // That's fine while only this service-role server calls them — if slot
  // booking is ever moved to a browser-side anon-key call, they'll need
  // re-granting or redefining as SECURITY DEFINER under RLS.
  app.post(
    '/api/slots/:slotId/hold',
    asyncHandler(async (req, res) => {
      const { slotId } = req.params;
      const { driverId, shipmentId } = req.body;
      const { data, error } = await supabase.rpc('hold_slot_atomic', {
        p_slot_id: slotId,
        p_driver_id: driverId,
        p_shipment_id: shipmentId,
      });
      if (error) throw error;
      res.json(data);
    })
  );

  app.post(
    '/api/slots/:slotId/confirm',
    asyncHandler(async (req, res) => {
      const { slotId } = req.params;
      const { driverId, shipmentId } = req.body;
      const { data, error } = await supabase.rpc('confirm_slot_atomic', {
        p_slot_id: slotId,
        p_shipment_id: shipmentId,
        p_driver_id: driverId,
      });
      if (error) throw error;
      res.json(data);
    })
  );

  app.post(
    '/api/slots/:slotId/release',
    asyncHandler(async (req, res) => {
      const { slotId } = req.params;
      const { driverId } = req.body;
      const { data, error } = await supabase.rpc('release_hold_atomic', {
        p_slot_id: slotId,
        p_driver_id: driverId,
      });
      if (error) throw error;
      res.json(data);
    })
  );
}
