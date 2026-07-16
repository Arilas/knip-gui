import type { Report } from '../core/types.js';
import type { ErrorBody } from './api-types.js';

export interface StoreError { code: string; message: string; stderr?: string; exitCode?: number }

// Flattens a StoreError to the wire-level ErrorBody (api-types.ts): `error` is
// always the human-readable string apiErrorMessage reads client-side, with
// `code`/`stderr` carried alongside for callers that want the structured
// detail too. Shared by every scan-failure response site (server/index.ts's
// /api/scan and routes-fix.ts's post-sweep rescan) so the three-field
// construction isn't duplicated.
export function toErrorBody(error: StoreError): ErrorBody {
  return { error: error.message, code: error.code, stderr: error.stderr };
}

// Every route that mutates the project on disk or this store — the initial scan,
// a sweep (`knip --fix`), or any patch-apply route — must hold this before doing
// so; see tryBeginOp/endOp below. The apply routes get their own op names rather
// than sharing one 'apply' so a 409 can name exactly which route is running.
export type BusyOp = 'scan' | 'sweep' | 'fix-apply' | 'ignore-apply' | 'ignore-remove-apply';

// Human-facing text for each BusyOp, used ONLY in 409 `error` strings (toasts).
// The hyphenated raw op names ('fix-apply', 'ignore-remove-apply', ...) are a
// machine-readable contract (task A1 — tests assert the structured `op` field
// verbatim), so routes must keep returning `op: store.activeOp` unchanged;
// this map exists purely so the prose alongside it doesn't leak the hyphens
// ("ignore-remove-apply in progress") into something a user actually reads.
export const BUSY_OP_LABELS: Record<BusyOp, string> = {
  scan: 'scan',
  sweep: 'sweep',
  'fix-apply': 'fix apply',
  'ignore-apply': 'ignore apply',
  'ignore-remove-apply': 'ignore removal',
};

export class ReportStore {
  status: 'idle' | 'scanning' | 'ready' | 'error' = 'idle';
  /**
   * Monotonic within a chain: only setReady assigns it, and nothing ever
   * clears it back to undefined once a scan has landed — a later 'scanning'
   * or 'error' status leaves the previous report in place. The preview
   * routes in routes-fix.ts lean on this: they gate on `store.report` being
   * present, not on `status === 'ready'`, precisely so a background rescan
   * (or a failed one) doesn't yank a still-usable report out from under an
   * in-flight preview/apply.
   */
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
  /**
   * The AbortController backing an in-flight `knip --fix` sweep (set by the sweep
   * route), or undefined when none is running. Separate from `activeAbort` because
   * a sweep is followed by its own rescan, and the CLI's close() must be able to
   * reap either an in-flight sweep child or an in-flight scan child on shutdown.
   */
  private activeSweepAbort?: AbortController;
  /**
   * Which mutating op currently holds the shared busy latch (undefined when none
   * does). Scan, sweep, and every apply route funnel through tryBeginOp/endOp
   * instead of each inventing its own local flag — a sweep rewriting files and a
   * fix apply rewriting files at the same time is a data race regardless of which
   * two ops collide, so one latch has to cover all of them, not one per route.
   * The one deliberate exception is the post-apply background rescan chain,
   * which reads (never writes) the project and coordinates through
   * rescanActive/rescanQueued below instead — see their comments for why
   * that is safe for applies and why scan/sweep still block on it.
   */
  activeOp?: BusyOp;
  /**
   * True while the post-apply background rescan chain is running (#33). The
   * chain deliberately does NOT hold `activeOp` — that is the entire fix:
   * applies (fast, disk-write-bounded, still individually latched via their
   * own op) no longer serialize behind a full knip scan. The cost is that an
   * iteration overlapped by an apply may land a stale (or torn-read error)
   * result; `rescanQueued` guarantees a corrective follow-up lands afterwards,
   * and no HTTP observer can catch the intermediate landing (the chain flips
   * status back to 'scanning' within the same microtask turn — see
   * runRescanChain in routes-fix.ts). Scan and sweep have NO corrective
   * mechanism — a stale chain landing could clobber their fresh results — so
   * their routes 409 while this is true, reported as op 'scan', exactly the
   * wire shape the old latch-holding rescan produced. That no-observable-
   * intermediate-landing guarantee holds WITHIN one chain; it does not
   * extend across two back-to-back chains — if an apply lands its queued
   * follow-up just as one chain exits and a new one starts, a 2s status poll
   * can in principle observe a transient 'ready' or 'error' for a few
   * milliseconds before the new chain's setScanning() runs. It's a narrow,
   * self-correcting window (the next poll sees 'scanning' again, then the
   * new chain's own 'ready'), not a state the system gets stuck in.
   */
  rescanActive = false;
  /**
   * Set by triggerBackgroundRescan when an apply lands while `rescanActive`;
   * consumed (once) by the chain loop to run one follow-up rescan. A boolean,
   * not a counter: N applies overlapping one iteration need exactly ONE
   * corrective rescan of the final on-disk state.
   */
  rescanQueued = false;

  /**
   * Synchronous check-and-set. Returns false without mutating state if another op
   * already holds the latch (so the caller can read `activeOp` back to report which
   * one); otherwise claims it for `op` and returns true. Callers MUST NOT `await`
   * between the guard they use to decide whether to call this and the call itself —
   * any gap lets two concurrent requests both observe the latch free and both
   * proceed. Route handlers are single-threaded (Node's event loop), so this plain
   * field check-and-set is all the synchronization a "no await in between" call
   * site needs; no actual lock is required.
   */
  tryBeginOp(op: BusyOp): boolean {
    if (this.activeOp) return false;
    this.activeOp = op;
    return true;
  }

  /**
   * Clears the latch unconditionally. Unlike endScan/endSweep (which compare
   * controller identity because a stale finally from an older attempt could
   * otherwise clobber a newer one's state), only one op can ever hold this latch
   * at a time by construction, so there's nothing to compare against.
   */
  endOp(): void {
    this.activeOp = undefined;
  }

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

  /** Call once per sweep attempt, right before invoking `sweep()`; pass the returned controller's `.signal` through. */
  beginSweep(): AbortController {
    const controller = new AbortController();
    this.activeSweepAbort = controller;
    return controller;
  }

  /** Call in the same attempt's `finally`, with the same controller `beginSweep` returned. */
  endSweep(controller: AbortController): void {
    if (this.activeSweepAbort === controller) this.activeSweepAbort = undefined;
  }

  /** Reap both an in-flight scan and an in-flight sweep child (CLI shutdown). No-op if nothing is running. */
  abortActive(): void {
    this.activeAbort?.abort();
    this.activeSweepAbort?.abort();
    // A close() mid-chain must not let the rescan loop consume a queued
    // follower and respawn a knip child that nothing will be left to reap.
    this.rescanQueued = false;
  }
}
