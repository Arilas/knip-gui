import type { Report } from '../core/types.js';

export interface StoreError { code: string; message: string; stderr?: string }

export class ReportStore {
  status: 'idle' | 'scanning' | 'ready' | 'error' = 'idle';
  report?: Report;
  error?: StoreError;
  /**
   * The workspace requested by the most recent scan attempt (set regardless of
   * success/failure). Rescans that don't carry their own explicit workspace
   * (the fire-and-forget post-apply rescan, the awaited post-sweep rescan)
   * read this back instead of defaulting to a full-project scan.
   */
  lastScanScope?: string;

  setScanning() { this.status = 'scanning'; this.error = undefined; }
  setReady(report: Report) { this.status = 'ready'; this.report = report; this.error = undefined; }
  setError(error: StoreError) { this.status = 'error'; this.error = error; }
}
