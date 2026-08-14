import React, { useState } from 'react';
import {
  X,
  AlertTriangle,
  Clock,
  Send,
  FileText,
  Wrench,
  ShieldAlert,
} from 'lucide-react';
import { ISSUE_CATEGORY_PRESETS } from '../data/issuePresets';
import { ExceptionType, IssueReport } from '../types';

interface IssueReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shipmentId: string;
  onSubmitIssue: (issue: Pick<IssueReport, 'shipmentId' | 'category' | 'estimatedDelayMinutes'>) => void;
}

export const IssueReportModal: React.FC<IssueReportModalProps> = ({
  isOpen,
  onClose,
  shipmentId,
  onSubmitIssue,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<ExceptionType>('traffic_delay');
  const [estimatedDelayMinutes, setEstimatedDelayMinutes] = useState<number>(30);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    onSubmitIssue({
      shipmentId,
      category: selectedCategory,
      estimatedDelayMinutes,
    });

    onClose();
  };

  const getPresetIcon = (iconName: string) => {
    switch (iconName) {
      case 'AlertTriangle':
        return <AlertTriangle className="w-5 h-5 text-amber-500" />;
      case 'Wrench':
        return <Wrench className="w-5 h-5 text-rose-500" />;
      case 'Clock':
        return <Clock className="w-5 h-5 text-blue-500" />;
      case 'ShieldAlert':
        return <ShieldAlert className="w-5 h-5 text-purple-500" />;
      default:
        return <FileText className="w-5 h-5 text-slate-400" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-lg shadow-2xl text-slate-800 overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 border border-rose-200 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 stroke-[2]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Report Delivery Issue</h2>
              <p className="text-xs text-slate-500">Shipment ID: <span className="text-indigo-700 font-mono font-bold">{shipmentId}</span></p>
            </div>
          </div>
          <button
            id="close-issue-modal"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-800 hover:bg-slate-200/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">

          {/* Issue Category Selector Chips */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-2">
              Issue Category
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ISSUE_CATEGORY_PRESETS.map((preset) => {
                const isSelected = selectedCategory === preset.category;
                return (
                  <button
                    key={preset.category}
                    type="button"
                    onClick={() => setSelectedCategory(preset.category)}
                    className={`flex items-center space-x-2.5 p-3 rounded-2xl border text-left transition-all ${
                      isSelected
                        ? 'bg-indigo-50 border-indigo-500 text-indigo-900 ring-2 ring-indigo-200 font-bold'
                        : 'bg-slate-50 border-slate-200/80 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {getPresetIcon(preset.icon)}
                    <span className="text-xs font-medium line-clamp-1">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Estimated Delay Minutes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1.5">
              Estimated Delay Impact
            </label>
            <div className="flex items-center space-x-2">
              {[15, 30, 45, 60, 90].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setEstimatedDelayMinutes(mins)}
                  className={`flex-1 py-2 text-xs font-bold rounded-xl border transition-all ${
                    estimatedDelayMinutes === mins
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  +{mins}m
                </button>
              ))}
            </div>
          </div>

          {/* Submit Actions */}
          <div className="pt-2 flex items-center justify-end space-x-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-600 hover:text-slate-900 transition-colors"
            >
              Cancel
            </button>
            <button
              id="submit-issue-btn"
              type="submit"
              className="flex items-center space-x-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-rose-600 text-white hover:bg-rose-700 shadow-md transition-all active:scale-95"
            >
              <Send className="w-4 h-4" />
              <span>Broadcast Issue to Dispatch</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
