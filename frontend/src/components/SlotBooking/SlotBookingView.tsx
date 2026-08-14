import React, { useCallback, useEffect, useState } from 'react';
import {
  PackageCheck,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  Loader2,
  XCircle,
} from 'lucide-react';
import { AppointmentSlotOption, Shipment } from '../../types';
import { confirmSlot, getBookableSlots, holdSlot, releaseSlot } from '../../api/client';

interface SlotBookingViewProps {
  shipment: Shipment | null;
  driverId: string;
  onBookingChange: () => void;
}

function formatTime(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const SlotBookingView: React.FC<SlotBookingViewProps> = ({ shipment, driverId, onBookingChange }) => {
  const [slots, setSlots] = useState<AppointmentSlotOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    if (!shipment) {
      setSlots([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setSlots(await getBookableSlots(shipment.id, driverId));
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load appointment slots.');
    } finally {
      setLoading(false);
    }
  }, [shipment, driverId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!shipment) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <div className="w-16 h-16 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-200">
          <PackageCheck className="w-8 h-8" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Active Shipment</h3>
        <p className="text-slate-500 text-sm max-w-md mx-auto">
          Dock appointments are booked against your current active shipment. You don't have one assigned right now.
        </p>
      </div>
    );
  }

  const appointment = shipment.appointment;
  const heldSlot = slots.find((s) => s.slotStatus === 'held');

  const handleHold = async (slotId: string) => {
    setBusySlotId(slotId);
    setActionError(null);
    try {
      const res = await holdSlot(slotId, driverId, shipment.id);
      if (res.status === 'conflict') {
        setActionError(res.message || 'That slot is no longer available. Pick another.');
      }
      await refresh();
      onBookingChange();
    } catch (err: any) {
      setActionError(err.message || 'Failed to hold slot.');
    } finally {
      setBusySlotId(null);
    }
  };

  const handleConfirm = async (slotId: string) => {
    setBusySlotId(slotId);
    setActionError(null);
    try {
      const res = await confirmSlot(slotId, driverId, shipment.id);
      if (res.status === 'expired_or_conflict') {
        setActionError('Your hold expired before you confirmed — pick a slot again.');
      }
      await refresh();
      onBookingChange();
    } catch (err: any) {
      setActionError(err.message || 'Failed to confirm slot.');
    } finally {
      setBusySlotId(null);
    }
  };

  const handleRelease = async (slotId: string) => {
    setBusySlotId(slotId);
    setActionError(null);
    try {
      await releaseSlot(slotId, driverId);
      await refresh();
      onBookingChange();
    } catch (err: any) {
      setActionError(err.message || 'Failed to release slot.');
    } finally {
      setBusySlotId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 text-slate-800">

      {/* Header Banner */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-indigo-500 via-teal-500 to-amber-500" />
        <div className="mt-1">
          <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
            DOCK APPOINTMENT
          </span>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight mt-2">
            Book a Dock Appointment for {shipment.id}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Destination: <span className="font-semibold text-slate-800">{shipment.destinationFacility.name} ({shipment.destinationFacility.city})</span>
          </p>
        </div>
      </div>

      {actionError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-start gap-2 text-xs text-rose-800">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}

      {appointment?.status === 'confirmed' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-3xl p-6 flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center border border-emerald-300">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-bold text-emerald-900">Dock Appointment Confirmed</p>
            <p className="text-xs text-emerald-800 mt-0.5">
              {formatTime(appointment.startTime)} – {formatTime(appointment.endTime)} (Slot {appointment.slotId})
            </p>
          </div>
        </div>
      )}

      {appointment?.status === 'pending' && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-6 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-800 flex items-center justify-center border border-amber-300">
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-bold text-amber-900">Holding Slot {appointment.slotId}</p>
              <p className="text-xs text-amber-800 mt-0.5">
                {formatTime(appointment.startTime)} – {formatTime(appointment.endTime)}
                {heldSlot?.heldUntil && (
                  <>
                    {' • '}
                    {new Date(heldSlot.heldUntil).getTime() > now
                      ? `expires in ${Math.max(0, Math.round((new Date(heldSlot.heldUntil).getTime() - now) / 1000))}s`
                      : 'hold expired — confirm may fail'}
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleConfirm(appointment.slotId)}
              disabled={busySlotId === appointment.slotId}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition-all active:scale-95 disabled:opacity-50"
            >
              {busySlotId === appointment.slotId ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>Confirm Appointment</span>
            </button>
            <button
              onClick={() => handleRelease(appointment.slotId)}
              disabled={busySlotId === appointment.slotId}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              <span>Release Hold</span>
            </button>
          </div>
        </div>
      )}

      {!appointment && (
        <>
          {loading ? (
            <div className="bg-white border border-slate-200/80 rounded-3xl p-12 text-center text-slate-500 shadow-sm">
              <Loader2 className="w-8 h-8 text-indigo-500 mx-auto mb-3 animate-spin" />
              <p className="text-sm font-medium">Loading compatible dock slots…</p>
            </div>
          ) : loadError ? (
            <div className="bg-rose-50 border border-rose-200 rounded-3xl p-6 text-center text-rose-800 text-sm">{loadError}</div>
          ) : slots.length === 0 ? (
            <div className="bg-white border border-slate-200/80 rounded-3xl p-12 text-center text-slate-500 shadow-sm">
              <PackageCheck className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-base font-bold text-slate-900 mb-1">No compatible slots at this facility yet</p>
              <p className="text-xs text-slate-500">
                No open dock accepts your vehicle type and cargo class right now. Check back later.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {slots.map((slot) => (
                <div
                  key={slot.slotId}
                  className="bg-white border border-slate-200/80 hover:border-indigo-300 rounded-3xl p-5 shadow-sm hover:shadow-md transition-all flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-xs font-mono font-bold text-indigo-900 bg-indigo-50 inline-block px-2 py-0.5 rounded-lg border border-indigo-200 mb-2">
                      {slot.dockName}
                    </p>
                    <p className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                      {formatTime(slot.startTime)} – {formatTime(slot.endTime)}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">Capacity: {slot.capacityUnits}</p>
                  </div>
                  <button
                    onClick={() => handleHold(slot.slotId)}
                    disabled={busySlotId === slot.slotId}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition-all active:scale-95 disabled:opacity-50 shrink-0"
                  >
                    {busySlotId === slot.slotId ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    <span>Hold</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
