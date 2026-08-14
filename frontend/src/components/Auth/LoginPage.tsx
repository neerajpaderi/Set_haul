import React, { useState } from 'react';
import { Truck, ShieldCheck, Lock, User, Eye, EyeOff, AlertCircle, ArrowRight, CheckCircle2, KeyRound } from 'lucide-react';

interface LoginPageProps {
  onLogin: (driverId: string) => void;
}

// Login itself stays a mocked/demo gate (no real password check) — but the
// IDs below are real driver_ids in the SetuHaul DB, so once "logged in" the
// app fetches that driver's actual profile/shipment data live.
export const DEMO_DRIVERS: { id: string; name: string; homeBase: string; password: string }[] = [
  { id: 'DRV-101', name: 'Ramesh Kumar', homeBase: 'Bengaluru', password: 'password123' },
  { id: 'DRV-102', name: 'Suresh Patel', homeBase: 'Bengaluru', password: 'password123' },
  { id: 'DRV-103', name: 'Anil Sharma', homeBase: 'Bengaluru', password: 'password123' },
];

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [driverId, setDriverId] = useState('DRV-101');
  const [password, setPassword] = useState('password123');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanId = driverId.trim().toUpperCase();
    const cleanPass = password.trim();

    if (!cleanId) {
      setErrorMsg('Please enter your assigned Driver ID (e.g. DRV-101).');
      return;
    }

    if (!cleanPass) {
      setErrorMsg('Please enter your account password.');
      return;
    }

    setIsLoading(true);

    setTimeout(() => {
      // Check if ID matches a demo driver or accepts any demo format
      const matchedDriver = DEMO_DRIVERS.find((d) => d.id === cleanId);

      if (matchedDriver) {
        if (cleanPass !== matchedDriver.password && cleanPass !== 'password123') {
          setErrorMsg('Incorrect password. For demo testing, use "password123".');
          setIsLoading(false);
          return;
        }
        onLogin(matchedDriver.id);
      } else {
        // Allow login with any DRV-XXX ID for flexibility — the app will
        // simply fail to find a matching driver in the DB after login.
        if (cleanId.startsWith('DRV-') || cleanId.length >= 4) {
          onLogin(cleanId);
        } else {
          setErrorMsg('Invalid Driver ID format. Valid formats start with "DRV-" (e.g. DRV-101).');
          setIsLoading(false);
        }
      }
    }, 600);
  };

  const handleSelectDemo = (demo: typeof DEMO_DRIVERS[0]) => {
    setDriverId(demo.id);
    setPassword(demo.password);
    setErrorMsg(null);
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8 selection:bg-indigo-100 selection:text-indigo-900">
      
      {/* Upper Brand Header */}
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 text-white shadow-xl shadow-indigo-600/20 mb-4 transform hover:scale-105 transition-transform">
          <Truck className="w-10 h-10 stroke-[2.2]" />
        </div>
        <div className="flex items-center justify-center space-x-2">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900">
            FLEETPULSE
          </h1>
          <span className="text-xs font-bold px-2.5 py-0.5 rounded-md bg-indigo-100 text-indigo-800 border border-indigo-200">
            DRIVER PORTAL
          </span>
        </div>
        <p className="mt-2 text-xs sm:text-sm text-slate-600 font-medium">
          Real-Time Shipment Telemetry & Driver Dispatch Console
        </p>
      </div>

      {/* Login Card Form */}
      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4">
        <div className="bg-white py-8 px-6 shadow-xl rounded-3xl border border-slate-200/90 sm:px-10 relative overflow-hidden">
          
          {/* Subtle Accent Line */}
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-indigo-500 via-indigo-600 to-indigo-700"></div>

          <div className="mb-6 pb-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Driver Authentication</h2>
              <p className="text-xs text-slate-500">Enter your credentials to access active loads</p>
            </div>
            <ShieldCheck className="w-6 h-6 text-indigo-600" />
          </div>

          {/* Error Message Alert */}
          {errorMsg && (
            <div className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex items-start space-x-3 text-xs text-rose-800 animate-in fade-in duration-200">
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold">Authentication Error</p>
                <p className="mt-0.5">{errorMsg}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            
            {/* Driver ID Input */}
            <div>
              <label htmlFor="driver-id-input" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Driver ID / Badge Number
              </label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="driver-id-input"
                  type="text"
                  value={driverId}
                  onChange={(e) => setDriverId(e.target.value)}
                  placeholder="e.g. DRV-101"
                  required
                  className="block w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                />
              </div>
            </div>

            {/* Password Input */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="password-input" className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                  Account Password
                </label>
                <span className="text-[11px] text-indigo-600 font-semibold cursor-pointer hover:underline">
                  Forgot PIN?
                </span>
              </div>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="password-input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="block w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                  title={showPassword ? 'Hide Password' : 'Show Password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Remember Me & Security Note */}
            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center space-x-2 cursor-pointer text-slate-700">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <span className="font-semibold">Remember driver badge on this device</span>
              </label>
            </div>

            {/* Submit Button */}
            <button
              id="btn-driver-signin"
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 rounded-xl text-sm font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-600/20 transition-all active:scale-[0.98] flex items-center justify-center space-x-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Verifying Driver Credentials...</span>
                </>
              ) : (
                <>
                  <span>Sign In to Dispatch Console</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

          </form>

          {/* Preset Demo Drivers Quick Picker */}
          <div className="mt-8 pt-6 border-t border-slate-200/80">
            <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-700 mb-3">
              <KeyRound className="w-3.5 h-3.5 text-indigo-600" />
              <span>Select Demo Driver Account:</span>
            </div>

            <div className="space-y-2">
              {DEMO_DRIVERS.map((demo) => {
                const isSelected = driverId === demo.id;
                return (
                  <button
                    key={demo.id}
                    type="button"
                    onClick={() => handleSelectDemo(demo)}
                    className={`w-full p-2.5 rounded-2xl border text-left transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-indigo-50/80 border-indigo-300 ring-2 ring-indigo-200'
                        : 'bg-slate-50/80 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center font-bold text-xs ${
                        isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {demo.name.split(' ').map((n) => n[0]).join('')}
                      </div>
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold text-slate-900">{demo.name}</span>
                          <span className="font-mono text-[10px] font-extrabold text-indigo-700 bg-indigo-100 px-1.5 py-0.2 rounded">
                            {demo.id}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 font-medium">Home base: {demo.homeBase}</p>
                      </div>
                    </div>

                    {isSelected && (
                      <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0 ml-2" />
                    )}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] text-center text-slate-400">
              Demo PIN for all accounts: <span className="font-mono font-bold text-slate-600">password123</span>
            </p>
          </div>

        </div>

        {/* Security & Support Info */}
        <div className="mt-6 text-center text-xs text-slate-500 space-y-1">
          <p className="font-semibold text-slate-600">FleetPulse Driver Dispatch System v3.2</p>
          <p>24/7 Dispatch Help Desk: +1 (800) 555-FLEET • HOS Electronic Log Compliant</p>
        </div>

      </div>

    </div>
  );
};
