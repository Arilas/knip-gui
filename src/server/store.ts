import type { Report } from '../core/types.js';

export interface StoreError { code: string; message: string; stderr?: string; exitCode?: number }

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
  /**
   * The AbortController backing whichever scan/rescan is currently in flight
   * (set by the route handler that starts it, via beginScan/endScan below), or
   * undefined when nothing is running. Lets a caller outside the request
   * lifecycle — the CLI's close(), reaping a stalled knip child on shutdown —
   * cancel it without the server needing any other handle back to the CLI.
   */
  private activeAbort?: AbortController;

  setScanning() { this.status = 'scanning'; this.error = undefined; }
  setReady(report: Report) { this.status = 'ready'; this.report = report; this.error = undefined; }
  setError(error: StoreError) { this.status = 'error'; this.error = error; }

  /** Call once per scan attempt, right before invoking `scan()`; pass the returned controller's `.signal` through. */
  beginScan(): AbortController {
    const controller = new AbortController();
    this.activeAbort = controller;
    return controller;
  }

  /** Call in the same attempt's `finally`, with the same controller `beginScan` returned. */
  endScan(controller: AbortController): void {
    if (this.activeAbort === controller) this.activeAbort = undefined;
  }

  /** No-op if nothing is in flight. */
  abortActiveScan(): void {
    this.activeAbort?.abort();
  }
}
