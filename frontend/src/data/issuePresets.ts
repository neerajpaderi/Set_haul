import { ExceptionType } from '../types';

// Labels/icons for the 5 real `exception_type` enum values in the DB.
export const ISSUE_CATEGORY_PRESETS: { category: ExceptionType; label: string; icon: string }[] = [
  { category: 'traffic_delay', label: 'Traffic Delay / Congestion', icon: 'AlertTriangle' },
  { category: 'breakdown', label: 'Truck Breakdown / Mechanical', icon: 'Wrench' },
  { category: 'late_departure', label: 'Late Departure from Origin', icon: 'Clock' },
  { category: 'accident', label: 'Accident / Collision', icon: 'ShieldAlert' },
  { category: 'other', label: 'Other Incident', icon: 'FileText' },
];
