import type { Report } from '../core/types.js';

export interface StoreError { code: string; message: string; stderr?: string }

export class ReportStore {
  status: 'idle' | 'scanning' | 'ready' | 'error' = 'idle';
  report?: Report;
  error?: StoreError;

  setScanning() { this.status = 'scanning'; this.error = undefined; }
  setReady(report: Report) { this.status = 'ready'; this.report = report; this.error = undefined; }
  setError(error: StoreError) { this.status = 'error'; this.error = error; }
}
