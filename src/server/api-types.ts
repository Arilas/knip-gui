// The client/server wire contract. Every /api/* response body type lives here
// and is imported BOTH by the route handlers (so `c.json(...)` payloads are
// compiler-checked against it) and by client/src/api.ts (type-only import —
// Vite elides it; keep this module free of value exports the client would
// pull in at runtime).
import type { Report } from '../core/types.js';
import type { FixPlan, PlanItem } from '../fix/compiler.js';
import type { PatchResult } from '../fix/patch.js';
import type { StoreError } from './store.js';

/**
 * Every non-2xx body. `error` is ALWAYS a human-readable string
 * (client/src/api.ts's apiErrorMessage only reads a string). `op` is the
 * machine-readable busy-op name on 409s (tests assert it verbatim).
 */
export interface ErrorBody {
  error: string;
  code?: string;
  stderr?: string;
  op?: string;
}

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error';

/** GET /api/report — unchanged shape; `error` stays structured for SetupScreen. */
export interface ReportResponse {
  status: ScanStatus;
  report?: Report;
  error?: StoreError;
}

/** GET /api/status — the slim poll target (#30). */
export interface StatusResponse {
  status: ScanStatus;
  /** The current report's scannedAt, if any — the client refetches the full report only when this changes. */
  scannedAt?: string;
  error?: StoreError;
}

/** POST /api/scan success. Failure is an ErrorBody. */
export interface ScanResponse {
  status: 'ready';
  issueCount: number;
}

/** POST /api/{fix,ignore}/preview and /api/ignores/remove/preview. */
export interface PreviewResponse {
  planId: string;
  diffs: FixPlan['diffs'];
  items: PlanItem[];
}

/** POST /api/{fix,ignore}/apply and /api/ignores/remove/apply. */
export interface ApplyResponse {
  results: PatchResult[];
  failedItems: PlanItem[];
  rescanning: boolean;
}

/** POST /api/sweep success. */
export interface SweepResponse {
  issueCount: number;
}
