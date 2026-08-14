import React, { useState } from 'react';
import { Search, CheckCircle2, ChevronRight, X, XCircle } from 'lucide-react';
import { Shipment } from '../../types';
import { ISSUE_CATEGORY_PRESETS } from '../../data/issuePresets';

interface ShipmentHistoryViewProps {
  history: Shipment[];
}

function categoryLabel(category: string) {
  return ISSUE_CATEGORY_PRESETS.find((p) => p.category === category)?.label ?? category;
}

function fmt(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const ShipmentHistoryView: React.FC<ShipmentHistoryViewProps> = ({ history }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);

  const filteredHistory = history.filter((item) => {
    const term = searchTerm.toLowerCase();
    return (
      item.id.toLowerCase().includes(term) ||
      item.productClass.toLowerCase().includes(term) ||
      item.originLabel.toLowerCase().includes(term) ||
      item.destinationFacility.name.toLowerCase().includes(term)
    );
  });

  const completedCount = history.filter((h) => h.status === 'completed').length;
  const cancelledCount = history.filter((h) => h.status === 'cancelled').length;
  const shipmentsWithIssuesCount = history.filter((h) => h.issues.length > 0).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 text-slate-800">

      {/* Header Banner */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-indigo-500 via-teal-500 to-amber-500" />
        <div className="mt-1">
          <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
            DRIVER SHIPMENT RECORDS
          </span>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight mt-2">Shipment History</h1>
          <p className="text-xs text-slate-500">Completed and cancelled shipments for this driver.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-6 pt-6 border-t border-slate-200/80">
          <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Completed</p>
            <p className="text-lg font-black text-emerald-700">{completedCount}</p>
          </div>
          <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Cancelled</p>
            <p className="text-lg font-black text-rose-700">{cancelledCount}</p>
          </div>
          <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">With Logged Issues</p>
            <p className="text-lg font-black text-amber-700">{shipmentsWithIssuesCount}</p>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-sm">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search history by Shipment ID, origin, destination, or cargo..."
            className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-4 py-2 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-indigo-500"
          />
        </div>
      </div>

      {/* History Records */}
      {history.length === 0 ? (
        <div className="bg-white border border-slate-200/80 rounded-3xl p-12 text-center text-slate-500 shadow-sm">
          <p className="text-base font-bold text-slate-900 mb-1">No completed shipments yet</p>
          <p className="text-xs text-slate-500">Once a shipment reaches completed or cancelled, it will show up here.</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs font-bold text-slate-700">
            <span>Past Shipments ({filteredHistory.length})</span>
            <span className="text-slate-500 font-normal">Click any row for details</span>
          </div>

          <div className="divide-y divide-slate-100">
            {filteredHistory.map((item) => (
              <div
                key={item.id}
                onClick={() => setSelectedShipment(item)}
                className="p-4 hover:bg-indigo-50/40 transition-colors cursor-pointer flex flex-col md:flex-row md:items-center justify-between gap-4 group"
              >
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-mono font-bold text-indigo-900 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                      {item.id}
                    </span>
                    {item.status === 'completed' ? (
                      <span className="text-xs font-bold text-emerald-800 flex items-center gap-1 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> COMPLETED
                      </span>
                    ) : (
                      <span className="text-xs font-bold text-rose-800 flex items-center gap-1 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                        <XCircle className="w-3.5 h-3.5 text-rose-600" /> CANCELLED
                      </span>
                    )}
                    {item.issues.length > 0 && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-900 border border-amber-200">
                        {item.issues.length} incident{item.issues.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  <p className="text-sm font-bold text-slate-900">
                    {item.originLabel} → {item.destinationFacility.name}
                  </p>

                  <p className="text-xs text-slate-500">
                    Cargo: <span className="text-slate-800 font-medium">{item.productClass}</span>
                  </p>
                </div>

                <div className="flex items-center justify-between md:justify-end space-x-6 text-xs">
                  <div className="text-right text-slate-500">
                    <p className="text-[11px] font-semibold text-slate-900">{fmt(item.completedAt || item.plannedEta)}</p>
                  </div>

                  <ChevronRight className="w-5 h-5 text-slate-400 group-hover:text-indigo-600 transition-colors" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shipment Detail Modal */}
      {selectedShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-2xl shadow-2xl text-slate-800 overflow-hidden my-8 animate-in fade-in zoom-in-95">

            <div className="p-6 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">{selectedShipment.id}</span>
                  <span className="text-xs font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                    {selectedShipment.status.toUpperCase()}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-slate-900 mt-1">Shipment Record</h2>
              </div>

              <button
                onClick={() => setSelectedShipment(null)}
                className="p-2 text-slate-400 hover:text-slate-800 rounded-xl hover:bg-slate-200/60"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">

              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2">
                <div className="flex justify-between">
                  <div>
                    <span className="text-[10px] text-emerald-800 font-bold uppercase">Origin</span>
                    <p className="text-sm font-bold text-slate-900">{selectedShipment.originLabel}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-indigo-800 font-bold uppercase">Destination</span>
                    <p className="text-sm font-bold text-slate-900">{selectedShipment.destinationFacility.name}</p>
                    <p className="text-slate-500">{selectedShipment.destinationFacility.city}</p>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-200 flex justify-between font-mono text-slate-700">
                  <span>Cargo: {selectedShipment.productClass}</span>
                  <span>Completed: {fmt(selectedShipment.completedAt)}</span>
                </div>
              </div>

              {selectedShipment.issues.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-bold text-slate-800">Logged Incidents During Haul:</h4>
                  {selectedShipment.issues.map((issue) => (
                    <div key={issue.id} className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-1">
                      <div className="flex justify-between font-bold text-indigo-900">
                        <span>{categoryLabel(issue.category)}</span>
                        <span className="text-[10px] text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                          {issue.status.replace('_', ' ').toUpperCase()}
                        </span>
                      </div>
                      <p className="text-slate-600 text-[11px]">+{issue.estimatedDelayMinutes} minute delay reported</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex justify-end">
                <button
                  onClick={() => setSelectedShipment(null)}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-sm"
                >
                  Close Record
                </button>
              </div>

            </div>

          </div>
        </div>
      )}

    </div>
  );
};
