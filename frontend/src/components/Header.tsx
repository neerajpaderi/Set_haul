import React from 'react';
import { Truck, PackageCheck, History, User, AlertCircle, ShieldCheck, Clock, MapPin, LogOut } from 'lucide-react';
import { DriverProfile, Shipment } from '../types';

interface HeaderProps {
  activeTab: 'active' | 'loads' | 'history' | 'profile';
  setActiveTab: (tab: 'active' | 'loads' | 'history' | 'profile') => void;
  driverProfile: DriverProfile;
  activeShipment: Shipment | null;
  unresolvedIssuesCount: number;
  availableLoadsCount: number;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  driverProfile,
  activeShipment,
  unresolvedIssuesCount,
  availableLoadsCount,
  onLogout,
}) => {
  const getDutyBadgeColor = (status: DriverProfile['status']) => {
    switch (status) {
      case 'active':
        return 'bg-emerald-100 text-emerald-900 border-emerald-300';
      case 'off_duty':
        return 'bg-amber-100 text-amber-900 border-amber-300';
      case 'inactive':
        return 'bg-slate-200 text-slate-800 border-slate-300';
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md text-slate-800 border-b border-slate-200 shadow-sm">
      {/* Top Banner */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo & Company Name */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-500/15">
              <Truck className="w-6 h-6 text-white stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-black text-lg tracking-tight text-slate-900">FLEETPULSE</span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
                  LOGISTICS
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block font-medium">Driver & Live Shipment Hub</p>
            </div>
          </div>

          {/* Active Route Quick Snapshot in Header */}
          {activeShipment && (
            <div className="hidden lg:flex items-center space-x-4 bg-indigo-50/70 px-3.5 py-1.5 rounded-xl border border-indigo-100/80">
              <div className="flex items-center space-x-2 text-xs">
                <span className="font-bold text-indigo-900">{activeShipment.id}</span>
                <span className="text-indigo-300">|</span>
                <span className="text-slate-700 font-medium flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-indigo-500" />
                  {activeShipment.originLabel} → {activeShipment.destinationFacility.name}
                </span>
              </div>
              <div className="flex items-center space-x-2 text-xs border-l border-indigo-200 pl-3">
                <Clock className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-slate-700">
                  ETA: <span className="font-bold text-slate-900">{activeShipment.latestEtaUpdate?.declaredEta || activeShipment.plannedEta}</span>
                </span>
              </div>
              {unresolvedIssuesCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] font-semibold bg-rose-100 text-rose-800 px-2.5 py-0.5 rounded-full border border-rose-200 animate-pulse">
                  <AlertCircle className="w-3 h-3 text-rose-600" />
                  {unresolvedIssuesCount} Delay Issue
                </span>
              )}
            </div>
          )}

          {/* Driver Duty Status & Driver Info */}
          <div className="flex items-center space-x-3">
            <div className="relative group">
              <div className="flex items-center space-x-2 bg-slate-100 rounded-xl p-1 border border-slate-200">
                <span className="text-xs font-semibold text-slate-600 px-2 hidden sm:inline-block">Status:</span>
                <span
                  className={`text-xs font-bold px-2.5 py-1 rounded-lg border ${getDutyBadgeColor(driverProfile.status)}`}
                  id="duty-status-badge"
                >
                  {driverProfile.status.replace('_', ' ').toUpperCase()}
                </span>
              </div>
            </div>

            {/* Driver Badge & Logout */}
            <div className="flex items-center space-x-2">
              <div
                onClick={() => setActiveTab('profile')}
                className="flex items-center space-x-2 bg-slate-100 hover:bg-slate-200/80 transition-colors p-1.5 rounded-xl border border-slate-200 cursor-pointer"
                title="View Driver Profile & Settings"
              >
                <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs border border-indigo-200">
                  {driverProfile.name.split(' ').map((n) => n[0]).join('')}
                </div>
                <div className="text-left hidden md:block">
                  <div className="text-xs font-bold text-slate-900 leading-tight">{driverProfile.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono font-medium">{driverProfile.assignedVehicle?.id ?? driverProfile.id}</div>
                </div>
              </div>

              {onLogout && (
                <button
                  id="btn-driver-logout"
                  onClick={onLogout}
                  className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-all flex items-center justify-center"
                  title="Sign Out of Driver Account"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="bg-slate-50/90 border-t border-slate-200/80 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex space-x-1 sm:space-x-2 overflow-x-auto py-2.5 no-scrollbar">
          
          <button
            id="tab-active-shipment"
            onClick={() => setActiveTab('active')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'active'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
            }`}
          >
            <Truck className="w-4 h-4" />
            <span>Active Shipment</span>
            {activeShipment && (
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md font-bold ${
                  activeTab === 'active'
                    ? 'bg-white/20 text-white'
                    : 'bg-indigo-100 text-indigo-800'
                }`}
              >
                {activeShipment.id}
              </span>
            )}
            {unresolvedIssuesCount > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
            )}
          </button>

          <button
            id="tab-accept-loads"
            onClick={() => setActiveTab('loads')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'loads'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
            }`}
          >
            <PackageCheck className="w-4 h-4" />
            <span>Dock Appointment</span>
            {availableLoadsCount > 0 && (
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  activeTab === 'loads'
                    ? 'bg-white/20 text-white'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                }`}
              >
                {availableLoadsCount} open slots
              </span>
            )}
          </button>

          <button
            id="tab-shipment-history"
            onClick={() => setActiveTab('history')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Shipment History</span>
          </button>

          <button
            id="tab-driver-profile"
            onClick={() => setActiveTab('profile')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'profile'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Driver Profile</span>
          </button>

        </div>
      </div>
    </header>
  );
};
