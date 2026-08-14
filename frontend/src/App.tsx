import React, { useEffect, useState } from 'react';
import { DriverProfile, ExceptionType, Shipment, ShipmentStatus } from './types';
import { Header } from './components/Header';
import { ActiveShipmentView } from './components/ActiveShipment/ActiveShipmentView';
import { SlotBookingView } from './components/SlotBooking/SlotBookingView';
import { ShipmentHistoryView } from './components/History/ShipmentHistoryView';
import { DriverProfileView } from './components/Profile/DriverProfileView';
import { IssueReportModal } from './components/IssueReportModal';
import { ChatbotWidget } from './components/Chatbot/ChatbotWidget';
import { LoginPage } from './components/Auth/LoginPage';
import * as api from './api/client';

export default function App() {
  const [activeTab, setActiveTab] = useState<'active' | 'loads' | 'history' | 'profile'>('active');

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => localStorage.getItem('fleetpulse_auth') === 'true');
  const [driverId, setDriverId] = useState<string | null>(() => localStorage.getItem('fleetpulse_driver_id'));

  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [activeShipment, setActiveShipment] = useState<Shipment | null>(null);
  const [shipmentHistory, setShipmentHistory] = useState<Shipment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [isIssueModalOpen, setIsIssueModalOpen] = useState(false);

  const loadDriverData = async (id: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [profile, shipment, history] = await Promise.all([
        api.getDriverProfile(id),
        api.getActiveShipment(id),
        api.getShipmentHistory(id),
      ]);
      setDriverProfile(profile);
      setActiveShipment(shipment);
      setShipmentHistory(history);
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load driver data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && driverId) {
      loadDriverData(driverId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, driverId]);

  // Two tabs logged in as different demo drivers would otherwise silently
  // clobber each other's session via localStorage.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'fleetpulse_driver_id' && e.newValue !== driverId) {
        window.location.reload();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [driverId]);

  const handleLogin = (id: string) => {
    localStorage.setItem('fleetpulse_auth', 'true');
    localStorage.setItem('fleetpulse_driver_id', id);
    setDriverId(id);
    setIsAuthenticated(true);
    setActiveTab('active');
  };

  const handleLogout = () => {
    localStorage.removeItem('fleetpulse_auth');
    localStorage.removeItem('fleetpulse_driver_id');
    setIsAuthenticated(false);
    setDriverId(null);
    setDriverProfile(null);
    setActiveShipment(null);
    setShipmentHistory([]);
  };

  const refreshActiveShipment = async () => {
    if (!driverId) return;
    setActiveShipment(await api.getActiveShipment(driverId));
  };

  const handleUpdateStatus = async (newStatus: ShipmentStatus) => {
    if (!activeShipment || !driverId) return;
    const updated = await api.updateShipmentStatus(activeShipment.id, newStatus);
    if (newStatus === 'completed' || newStatus === 'cancelled') {
      setActiveShipment(null);
      setShipmentHistory(await api.getShipmentHistory(driverId));
      setActiveTab('history');
    } else {
      setActiveShipment(updated);
    }
  };

  const handleSubmitIssue = async (issueData: { shipmentId: string; category: ExceptionType; estimatedDelayMinutes: number }) => {
    await api.reportIssue(issueData.shipmentId, issueData.category, issueData.estimatedDelayMinutes);
    await refreshActiveShipment();
  };

  const handleResolveIssue = async (issueId: string) => {
    await api.resolveIssue(issueId);
    await refreshActiveShipment();
  };

  const unresolvedCount = activeShipment
    ? activeShipment.issues.filter((i) => !['resolved', 'cancelled'].includes(i.status)).length
    : 0;

  if (!isAuthenticated || !driverId) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (isLoading && !driverProfile) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <p className="text-slate-500 text-sm font-medium">Loading driver data…</p>
      </div>
    );
  }

  if (loadError || !driverProfile) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-rose-700 text-sm font-medium max-w-md">{loadError || `Driver ${driverId} not found.`}</p>
        <button
          onClick={handleLogout}
          className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold"
        >
          Back to Login
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] font-sans antialiased text-slate-800 flex flex-col selection:bg-amber-200 selection:text-amber-900">

      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        driverProfile={driverProfile}
        activeShipment={activeShipment}
        unresolvedIssuesCount={unresolvedCount}
        availableLoadsCount={0}
        onLogout={handleLogout}
      />

      <main className="flex-1 pb-12">
        {activeTab === 'active' && (
          <ActiveShipmentView
            shipment={activeShipment}
            onUpdateStatus={handleUpdateStatus}
            onOpenIssueModal={() => setIsIssueModalOpen(true)}
            onResolveIssue={handleResolveIssue}
          />
        )}

        {activeTab === 'loads' && (
          <SlotBookingView
            shipment={activeShipment}
            driverId={driverId}
            onBookingChange={refreshActiveShipment}
          />
        )}

        {activeTab === 'history' && <ShipmentHistoryView history={shipmentHistory} />}

        {activeTab === 'profile' && (
          <DriverProfileView driverProfile={driverProfile} onLogout={handleLogout} />
        )}
      </main>

      {activeShipment && (
        <IssueReportModal
          isOpen={isIssueModalOpen}
          onClose={() => setIsIssueModalOpen(false)}
          shipmentId={activeShipment.id}
          onSubmitIssue={handleSubmitIssue}
        />
      )}

      <ChatbotWidget
        activeShipment={activeShipment}
        driverProfile={driverProfile}
        onSubmitIssue={handleSubmitIssue}
        onOpenIssueModal={() => setIsIssueModalOpen(true)}
      />

      <footer className="bg-white border-t border-slate-200/80 py-4 text-center text-xs text-slate-500 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="font-medium">© 2026 FleetPulse Logistics Inc. • Driver Telemetry & Real-Time Tracking Platform</p>
          <div className="flex items-center space-x-4 text-[11px]">
            <span className="text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Dispatch Network Connected
            </span>
            <span className="text-slate-600 bg-slate-100 px-2.5 py-0.5 rounded-full font-medium">HOS Safety Compliant</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
