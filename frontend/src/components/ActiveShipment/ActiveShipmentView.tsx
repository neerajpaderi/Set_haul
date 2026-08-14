import React, { useState } from 'react';
import {
  Truck,
  MapPin,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Navigation,
  Package,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Shipment, ShipmentStatus } from '../../types';
import { ISSUE_CATEGORY_PRESETS } from '../../data/issuePresets';

interface ActiveShipmentViewProps {
  shipment: Shipment | null;
  onUpdateStatus: (newStatus: ShipmentStatus) => void;
  onOpenIssueModal: () => void;
  onResolveIssue: (issueId: string) => void;
}

// 'planned' is the initial state a shipment starts in — no button needed to
// set it. 'cancelled' isn't offered here; nothing in this UI cancels a
// shipment today.
const STATUS_PROGRESSION: { status: ShipmentStatus; label: string }[] = [
  { status: 'in_transit', label: '1. En Route / Driving' },
  { status: 'arrived', label: '2. Arrived at Destination' },
  { status: 'completed', label: '3. Completed' },
];

function categoryLabel(category: string) {
  return ISSUE_CATEGORY_PRESETS.find((p) => p.category === category)?.label ?? category;
}

const UNRESOLVED_EXCEPTION_STATUSES = ['open', 'awaiting_driver', 'awaiting_facility', 'escalated'];

export const ActiveShipmentView: React.FC<ActiveShipmentViewProps> = ({
  shipment,
  onUpdateStatus,
  onOpenIssueModal,
  onResolveIssue,
}) => {
  const [resolvingIssueId, setResolvingIssueId] = useState<string | null>(null);

  if (!shipment) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <div className="w-16 h-16 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-200">
          <Truck className="w-8 h-8" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Active Shipment Assigned</h3>
        <p className="text-slate-500 text-sm max-w-md mx-auto mb-6">
          You currently do not have an active load en route.
        </p>
      </div>
    );
  }

  const getStatusBadge = (status: ShipmentStatus) => {
    switch (status) {
      case 'in_transit':
        return 'bg-emerald-100 text-emerald-900 border-emerald-300';
      case 'arrived':
        return 'bg-blue-100 text-blue-900 border-blue-300';
      case 'completed':
        return 'bg-emerald-600 text-white border-emerald-500';
      case 'cancelled':
        return 'bg-rose-100 text-rose-900 border-rose-300';
      default:
        return 'bg-slate-100 text-slate-800 border-slate-300';
    }
  };

  const activeIssues = shipment.issues.filter((i) => UNRESOLVED_EXCEPTION_STATUSES.includes(i.status));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 text-slate-800">

      {/* Active Shipment Header Card */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-indigo-500 via-teal-500 to-amber-500" />

        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 pb-6 border-b border-slate-200/80 mt-1">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
                ACTIVE SHIPMENT
              </span>
              <h1 className="text-2xl font-black text-slate-900 tracking-tight">{shipment.id}</h1>
              <span className={`text-xs font-bold px-3 py-1 rounded-full border ${getStatusBadge(shipment.status)}`}>
                {shipment.status.replace('_', ' ')}
              </span>
            </div>

            <p className="text-sm text-slate-600 font-medium">
              Cargo: <span className="text-slate-900 font-semibold">{shipment.productClass}</span> (Priority {shipment.priority})
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 bg-amber-50/80 p-3.5 rounded-2xl border border-amber-200/80">
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Driver ID</p>
              <p className="text-sm font-extrabold text-amber-900 font-mono">{shipment.driverId}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Vehicle</p>
              <p className="text-sm font-bold text-slate-800 truncate flex items-center gap-1" title={shipment.vehicle?.type}>
                <Truck className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                {shipment.vehicle?.type ?? '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Origin vs Destination Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6">
          <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-2xl p-4 relative flex flex-col justify-between">
            <div className="flex items-center space-x-2 mb-3">
              <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center border border-emerald-300">
                <MapPin className="w-4 h-4 text-emerald-700" />
              </div>
              <div>
                <span className="text-[10px] font-extrabold tracking-wider uppercase text-emerald-800">ORIGIN</span>
                <h3 className="text-base font-bold text-slate-900 leading-tight">{shipment.originLabel}</h3>
              </div>
            </div>
            <p className="text-xs text-slate-600 font-medium">
              Shipment planned {new Date(shipment.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>

          <div className="bg-indigo-50/60 border border-indigo-200/80 rounded-2xl p-4 relative flex flex-col justify-between">
            <div className="flex items-center space-x-2 mb-3">
              <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-800 flex items-center justify-center border border-indigo-300">
                <Navigation className="w-4 h-4 text-indigo-700" />
              </div>
              <div>
                <span className="text-[10px] font-extrabold tracking-wider uppercase text-indigo-800">DESTINATION</span>
                <h3 className="text-base font-bold text-slate-900 leading-tight">
                  {shipment.destinationFacility.name} ({shipment.destinationFacility.city})
                </h3>
              </div>
            </div>

            <div className="pt-3 border-t border-indigo-200/80 flex items-center justify-between text-xs">
              <span className="text-slate-600 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-indigo-600" />
                ETA:
              </span>
              <span className="font-black text-indigo-900 text-sm">
                {shipment.latestEtaUpdate?.declaredEta
                  ? new Date(shipment.latestEtaUpdate.declaredEta).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : new Date(shipment.plannedEta).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {shipment.latestEtaUpdate && (
              <div className="mt-1 text-[11px] text-indigo-800 font-semibold text-right flex items-center justify-end gap-1">
                <Info className="w-3 h-3 text-indigo-600" /> {shipment.latestEtaUpdate.confidenceNote || `Source: ${shipment.latestEtaUpdate.sourceType}`}
              </div>
            )}
            {shipment.appointment && (
              <div className="mt-1 text-[11px] text-indigo-800 font-semibold text-right">
                Dock appointment: {shipment.appointment.status}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Driver Real-Time Actions & Status Progression */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200/80">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Truck className="w-5 h-5 text-indigo-600" />
              Driver Status Control & Incident Logging
            </h2>
            <p className="text-xs text-slate-500">
              Update shipment status with one click or log transit issues effortlessly.
            </p>
          </div>

          <button
            id="report-issue-btn"
            onClick={onOpenIssueModal}
            className="flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 text-xs font-bold transition-all shadow-sm active:scale-95"
          >
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            <span>Report Issue / Delay</span>
          </button>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            Quick Driver Status Update
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {STATUS_PROGRESSION.map((item) => {
              const isCurrent = shipment.status === item.status;
              return (
                <button
                  key={item.status}
                  id={`status-btn-${item.status}`}
                  onClick={() => onUpdateStatus(item.status)}
                  className={`px-3 py-3 rounded-2xl border text-center transition-all flex flex-col items-center justify-center space-y-1 ${
                    isCurrent
                      ? 'bg-indigo-600 text-white border-indigo-500 font-extrabold shadow-md scale-[1.02]'
                      : 'bg-slate-50 text-slate-700 border-slate-200/90 hover:bg-slate-100/80 hover:border-slate-300'
                  }`}
                >
                  <span className="text-xs line-clamp-1">{item.label}</span>
                  {isCurrent && <span className="text-[10px] font-bold uppercase tracking-wider opacity-90">Current</span>}
                </button>
              );
            })}
          </div>
        </div>

        {activeIssues.length > 0 && (
          <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between text-rose-900 text-xs font-bold uppercase tracking-wider">
              <span className="flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-rose-600 animate-pulse" />
                Active Unresolved Delay Issues ({activeIssues.length})
              </span>
            </div>

            <div className="space-y-3">
              {activeIssues.map((issue) => (
                <div key={issue.id} className="bg-white p-3.5 rounded-xl border border-rose-200/80 shadow-sm space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs font-bold text-rose-900">{categoryLabel(issue.category)}</span>
                      <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-2">
                        <span>⏱ +{issue.estimatedDelayMinutes}m delay</span>
                        <span>•</span>
                        <span>{new Date(issue.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        <span>•</span>
                        <span className="font-semibold">{issue.status.replace('_', ' ')}</span>
                      </p>
                    </div>

                    <button
                      onClick={() => (resolvingIssueId === issue.id ? setResolvingIssueId(null) : onResolveIssue(issue.id))}
                      className="px-3 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold rounded-lg border border-emerald-200 transition-colors"
                    >
                      Mark Resolved
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Route & Progress */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-4">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Navigation className="w-5 h-5 text-indigo-600" />
          Shipment Progress
        </h2>

        <div>
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Progress: <strong className="text-indigo-600 font-bold">{shipment.currentProgressPercent}%</strong></span>
          </div>
          <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-teal-500 rounded-full transition-all duration-500"
              style={{ width: `${shipment.currentProgressPercent}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          {shipment.waypoints.map((wp, index) => (
            <div
              key={index}
              className={`p-3.5 rounded-2xl border relative transition-all ${
                wp.completed
                  ? 'bg-teal-50/80 border-teal-200/90 text-slate-900'
                  : 'bg-slate-50 border-slate-200/80 text-slate-500'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase ${
                  wp.completed ? 'bg-teal-100 text-teal-900' : 'bg-slate-200 text-slate-700'
                }`}>
                  {wp.type}
                </span>
                {wp.completed && <CheckCircle2 className="w-4 h-4 text-teal-600" />}
              </div>
              <p className="text-xs font-bold text-slate-900 line-clamp-1">{wp.name}</p>
              {(wp.actualArrival || wp.estimatedArrival) && (
                <p className="text-[11px] text-slate-600 mt-1">
                  {wp.actualArrival ? 'Arrived: ' : 'ETA: '}
                  {new Date(wp.actualArrival || wp.estimatedArrival!).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-4">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Clock className="w-5 h-5 text-indigo-600" />
          Live Shipment Event Timeline
        </h2>

        <div className="space-y-4 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
          {shipment.timeline.map((event) => (
            <div key={event.id} className="relative pl-8 space-y-0.5">
              <div className="absolute left-1.5 top-1.5 w-3 h-3 rounded-full bg-indigo-600 ring-4 ring-indigo-50" />
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-900">{event.title}</h4>
                <span className="text-[10px] text-slate-500 font-medium">
                  {new Date(event.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="text-xs text-slate-600">{event.description}</p>
              <div className="flex items-center space-x-2 text-[10px] text-slate-500 mt-1">
                <Package className="w-3 h-3" />
                <span>{event.location}</span>
                <span>•</span>
                <span className="font-semibold text-indigo-700">{event.author} UPDATE</span>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};
