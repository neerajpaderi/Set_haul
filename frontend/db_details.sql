-- =====================================================================
-- SETUHAUL — MIGRATION v2 (adapted to existing `appointments` table)
--
-- Existing schema (confirmed):
--   appointments.status is enum `appointment_status`:
--     pending | confirmed | cancelled | superseded
--
-- Mapping used below:
--   "held"      -> pending      (slot temporarily reserved, not yet committed)
--   "confirmed" -> confirmed    (unchanged)
--   driver cancels a hold        -> cancelled
--   a NEW confirmed slot replaces an OLD confirmed slot for the same
--   shipment -> the OLD row becomes superseded (not cancelled — it
--   wasn't backed out, it was replaced)
--
-- Nothing here touches your existing `appointments` table structure.
-- Only appointment_slots.slot_status/held_by/held_at/held_until/version
-- are used, and those columns already exist and are currently unused.
-- =====================================================================

-- 1. One active (pending/confirmed) appointment per shipment at a time.
--    Safe to run even if it already exists.
create unique index if not exists uq_appointments_active_shipment
    on appointments(shipment_id)
    where status in ('pending', 'confirmed');

-- 2. Atomic hold: succeeds only if slot is available, or its previous
--    hold has expired. This is the single choke point preventing two
--    drivers from both "winning" the same slot.
create or replace function hold_slot_atomic(
    p_slot_id text,
    p_driver_id text,
    p_shipment_id text,
    p_hold_seconds int default 180
) returns jsonb as $$
declare
    v_rows int;
    v_hold_until timestamptz := now() + make_interval(secs => p_hold_seconds);
begin
    update appointment_slots
    set slot_status = 'held',
        held_by     = p_driver_id,
        held_at     = now(),
        held_until  = v_hold_until,
        version     = version + 1
    where slot_id = p_slot_id
      and (slot_status = 'available' or (slot_status = 'held' and held_until < now()));

    get diagnostics v_rows = row_count;

    if v_rows = 0 then
        return jsonb_build_object('status', 'conflict', 'message', 'Slot is no longer available.');
    end if;

    -- any prior pending hold by this shipment becomes cancelled (superseded by this new pick)
    update appointments
        set status = 'cancelled'::appointment_status
        where shipment_id = p_shipment_id and status = 'pending'::appointment_status;

    insert into appointments (appointment_id, shipment_id, slot_id, status, booked_at)
    values (
        'APT-' || substr(gen_random_uuid()::text, 1, 8),
        p_shipment_id,
        p_slot_id,
        'pending'::appointment_status,
        now()
    );

    return jsonb_build_object(
        'status', 'held',
        'slot_id', p_slot_id,
        'held_until', v_hold_until
    );
end;
$$ language plpgsql;

-- 3. Atomic confirm: only succeeds if the calling driver still holds
--    the slot and the hold has not expired. If this shipment already
--    had a CONFIRMED slot, that old row is marked superseded and its
--    slot freed (scoped strictly to this shipment_id — never touches
--    other shipments' bookings).
create or replace function confirm_slot_atomic(
    p_slot_id text,
    p_shipment_id text,
    p_driver_id text
) returns jsonb as $$
declare
    v_rows int;
    v_old_slot_id text;
begin
    select slot_id into v_old_slot_id
        from appointments
        where shipment_id = p_shipment_id and status = 'confirmed'::appointment_status
        limit 1;

    if v_old_slot_id is not null and v_old_slot_id <> p_slot_id then
        update appointment_slots
            set slot_status = 'available', held_by = null, held_until = null
            where slot_id = v_old_slot_id;

        update appointments
            set status = 'superseded'::appointment_status
            where shipment_id = p_shipment_id
              and slot_id = v_old_slot_id
              and status = 'confirmed'::appointment_status;
    end if;

    update appointment_slots
    set slot_status = 'booked', held_by = null, held_until = null, version = version + 1
    where slot_id = p_slot_id
      and held_by = p_driver_id
      and held_until > now();

    get diagnostics v_rows = row_count;

    if v_rows = 0 then
        return jsonb_build_object('status', 'expired_or_conflict',
            'message', 'Hold expired or slot no longer belongs to this driver.');
    end if;

    update appointments
        set status = 'confirmed'::appointment_status, confirmed_at = now()
        where shipment_id = p_shipment_id
          and slot_id = p_slot_id
          and status = 'pending'::appointment_status;

    return jsonb_build_object('status', 'confirmed', 'slot_id', p_slot_id);
end;
$$ language plpgsql;

-- 4. Release a pending hold explicitly (driver changes their mind).
create or replace function release_hold_atomic(
    p_slot_id text,
    p_driver_id text
) returns jsonb as $$
declare
    v_rows int;
begin
    update appointment_slots
    set slot_status = 'available', held_by = null, held_until = null, version = version + 1
    where slot_id = p_slot_id and held_by = p_driver_id;

    get diagnostics v_rows = row_count;
    if v_rows = 0 then
        return jsonb_build_object('status', 'not_held', 'message', 'No active hold by this driver on this slot.');
    end if;

    update appointments
        set status = 'cancelled'::appointment_status
        where slot_id = p_slot_id and status = 'pending'::appointment_status;

    return jsonb_build_object('status', 'released', 'slot_id', p_slot_id);
end;
$$ language plpgsql;

-- 5. Optional housekeeping sweep: expired holds fall back to available
--    automatically on next read via the WHERE clause in hold_slot_atomic,
--    but this keeps plain SELECTs on appointment_slots honest too.
--    Wire this to a Supabase scheduled function / pg_cron if desired.
create or replace function sweep_expired_holds() returns void as $$
begin
    update appointment_slots
    set slot_status = 'available', held_by = null, held_until = null
    where slot_status = 'held' and held_until < now();

    update appointments
    set status = 'cancelled'::appointment_status
    where status = 'pending'::appointment_status
      and slot_id in (
          select slot_id from appointment_slots where slot_status = 'available'
      );
end;
$$ language plpgsql;