import React from 'react';
import { User, Truck, Phone, MapPin, Building2, LogOut, ShieldCheck, Snowflake, Ruler } from 'lucide-react';
import { DriverProfile } from '../../types';

interface DriverProfileViewProps {
  driverProfile: DriverProfile;
  onLogout?: () => void;
}

function statusBadgeColor(status: DriverProfile['status']) {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-900 border-emerald-300';
    case 'off_duty':
      return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'inactive':
      return 'bg-slate-200 text-slate-800 border-slate-300';
  }
}

export const DriverProfileView: React.FC<DriverProfileViewProps> = ({ driverProfile, onLogout }) => {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 text-slate-800">

      {/* Header Banner */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-indigo-500 via-teal-500 to-amber-500" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mt-1">
          <div className="flex items-center space-x-4">
            <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-900 flex items-center justify-center font-black text-xl border border-indigo-200 shadow-sm">
              {driverProfile.name.split(' ').map((n) => n[0]).join('')}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-2xl font-black text-slate-900">{driverProfile.name}</h1>
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${statusBadgeColor(driverProfile.status)}`}>
                  {driverProfile.status.replace('_', ' ').toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-mono mt-0.5">Driver ID: {driverProfile.id}</p>
            </div>
          </div>

          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center space-x-1.5 px-3.5 py-3 rounded-2xl bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 text-xs font-bold transition-all shadow-sm active:scale-95 shrink-0"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4 text-rose-600" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

        {/* Driver Details */}
        <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <User className="w-5 h-5 text-indigo-600" />
            Driver Details
          </h2>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
              <span className="text-slate-600 font-medium flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> Phone</span>
              <span className="font-bold text-slate-900">{driverProfile.phone}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
              <span className="text-slate-600 font-medium flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> Home Base</span>
              <span className="font-bold text-slate-900">{driverProfile.homeBase}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
              <span className="text-slate-600 font-medium flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Carrier</span>
              <span className="font-bold text-slate-900">{driverProfile.carrierId}</span>
            </div>
          </div>
        </div>

        {/* Assigned Vehicle */}
        <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Truck className="w-5 h-5 text-indigo-600" />
            Assigned Vehicle
          </h2>

          {driverProfile.assignedVehicle ? (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
                <span className="text-slate-600 font-medium">Vehicle ID</span>
                <span className="font-bold text-slate-900 font-mono">{driverProfile.assignedVehicle.id}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
                <span className="text-slate-600 font-medium">Type</span>
                <span className="font-bold text-slate-900">{driverProfile.assignedVehicle.type}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
                <span className="text-slate-600 font-medium flex items-center gap-1.5"><Ruler className="w-3.5 h-3.5" /> Length</span>
                <span className="font-bold text-slate-900">{driverProfile.assignedVehicle.lengthFt} ft</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
                <span className="text-slate-600 font-medium flex items-center gap-1.5"><Snowflake className="w-3.5 h-3.5" /> Refrigeration</span>
                <span className="font-bold text-slate-900">{driverProfile.assignedVehicle.refrigerationRequired ? 'Required' : 'Not Required'}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
                <span className="text-slate-600 font-medium flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Status</span>
                <span className="font-bold text-slate-900">{driverProfile.assignedVehicle.status}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No vehicle assigned yet.</p>
          )}
        </div>

      </div>

    </div>
  );
};
