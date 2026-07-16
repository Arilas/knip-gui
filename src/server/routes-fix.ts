import type { Context, Hono } from 'hono';
import { runScan } from '../core/knip-runner.js';
import { compileFixPlan } from '../fix/compiler.js';
import { compileIgnorePlan } from '../ignore/compile.js';
import type { FixMode } from '../core/types.js';
import { applyPatches, type PatchResult } from '../fix/patch.js';
import type { PlanStore } from '../fix/plan-store.js';
import { probeSweepCapabilities, runSweep } from '../fix/sweep.js';
import { readJsonObject } from './body.js';
import { runScanIntoStore } from './scan-runner.js';
import { BUSY_OP_LABELS, toErrorBody, type BusyOp, type ReportStore, type StoreError } from './store.js';
import type { ApplyResponse, PreviewResponse, SweepResponse } from './api-types.js';

export interface FixRoutesCtx {
  projectDir: string;
  scan: typeof runScan;
  /** Defaults to the real `runSweep` in createServer; injectable so tests can stall it to exercise the sweep latch. */
  sweep?: typeof runSweep;
  store: ReportStore;
  planStore: PlanStore;
  /** Fixed for the server's lifetime — see createServer's `production` option. Applied to every rescan. */
  production: boolean;
}

// Runs a rescan and lands the outcome in the store — the shared core of both the
// awaited (sweep) and fire-and-forget (fix/ignore apply) rescan paths. Reuses the
// last scan's workspace rather than silently widening back to a full-project scan
// (Plan 2 carried-over obligation). Caller must have already set the store to
// 'scanning' before calling.
function performRescan(
  ctx: FixRoutesCtx,
): Promise<{ ok: true; issueCount: number } | { ok: false; error: StoreError }> {
  return runScanIntoStore({
    store: ctx.store,
    scan: ctx.scan,
    projectDir: ctx.projectDir,
    production: ctx.production,
    workspace: ctx.store.lastScanScope,
  });
}

// Fire-and-forget rescan chain after a fix/ignore apply (#33). Unlike the
// pre-#33 version, this does NOT take the shared busy latch: holding
// tryBeginOp('scan') through a 60–120s monorepo rescan made every
// subsequent apply 409 behind it. Instead the chain runs under the store's
// rescanActive flag; an apply landing mid-chain sets rescanQueued and gets
// exactly one corrective follow-up iteration (see runRescanChain).
// Scan/sweep routes 409 while the chain runs (their guards check
// rescanActive) because a stale chain landing could clobber their fresh
// results and they have no follow-up mechanism to correct it.
// Exported for routes-ignores.ts via applyPlanHandler, same as before.
export function triggerBackgroundRescan(ctx: FixRoutesCtx): boolean {
  const { store } = ctx;
  if (store.rescanActive) {
    // Coalesce: the running chain observes this once its current iteration
    // lands and runs ONE corrective follow-up over the final disk state.
    store.rescanQueued = true;
    return true;
  }
  // Cheap insurance, same spirit as the tryBeginOp('scan') guard this
  // replaces: from applyPlanHandler this can't fire (the handler released
  // its own op synchronously in the same tick, and nothing else can have
  // claimed the latch with no await in the gap), but a future caller
  // arriving while a sweep or manual scan holds the latch must not start a
  // chain that races it.
  if (store.activeOp) return false;
  store.rescanActive = true;
  // Synchronous with the apply that triggered us: the apply's HTTP response
  // is sent after this returns, so a client polling right after an apply
  // always observes 'scanning' (codepane-crash.spec.ts pins exactly this).
  store.setScanning();
  void runRescanChain(ctx);
  return true;
}

// The chain loop. Queued-follow-up was chosen over abort-and-restart
// (store.activeAbort) deliberately: no abort-vs-failure classification in
// runScanIntoStore, no latch-ownership transfer out of a preempted finally,
// no killed-child semantics — the price is one doomed iteration's remaining
// runtime before the corrective one, paid only when applies actually
// overlap a rescan.
//
// Status is never observably wrong mid-chain: between an iteration's own
// setReady/setError (inside runScanIntoStore) and the loop's next
// setScanning there are only synchronous frames and already-resolved-
// promise await resumptions — pure microtasks, which Node drains before
// any macrotask, and an incoming HTTP request is a macrotask. Observers
// therefore see 'scanning' continuously from the first apply until the
// FINAL landing.
async function runRescanChain(ctx: FixRoutesCtx): Promise<void> {
  const { store } = ctx;
  try {
    do {
      store.rescanQueued = false;
      store.setScanning();
      await performRescan(ctx);
    } while (store.rescanQueued);
  } finally {
    store.rescanActive = false;
  }
}

// The one apply handler all three plan-consuming routes share (#41): latch →
// planStore.take → applyPatches → endOp → triggerBackgroundRescan. The latch
// invariants live HERE, once: no await between tryBeginOp and acting on it,
// and endOp() released synchronously with no await before
// triggerBackgroundRescan — so nothing can claim the latch in the gap, which
// is what lets triggerBackgroundRescan treat a held activeOp as "a caller
// other than us" (see its insurance guard). Exported for routes-ignores.ts.
export function applyPlanHandler(ctx: FixRoutesCtx, op: BusyOp) {
  return async (c: Context) => {
    const { store, planStore, projectDir } = ctx;
    if (!store.tryBeginOp(op)) {
      return c.json({ error: `${BUSY_OP_LABELS[store.activeOp!]} in progress`, op: store.activeOp }, 409);
    }
    const body = await readJsonObject(c);
    const plan = planStore.take(typeof body.planId === 'string' ? body.planId : '');
    if (!plan) {
      store.endOp();
      return c.json({ error: 'unknown or already-applied plan' }, 404);
    }
    let results: PatchResult[];
    try {
      results = await applyPatches(projectDir, plan.patches);
    } finally {
      store.endOp();
    }
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning } satisfies ApplyResponse);
  };
}

export function registerFixRoutes(app: Hono, ctx: FixRoutesCtx): void {
  const { store, planStore, projectDir, sweep = runSweep } = ctx;

  app.post('/api/fix/preview', async (c) => {
    // Requires a report to compile against, not a 'ready' status (#33):
    // during a post-apply background rescan the store is 'scanning' but still
    // holds the previous report, and gating on 'ready' here would
    // re-serialize consecutive apply flows behind the very scan the rescan
    // chain stopped blocking on. Compiling against a possibly-stale report is
    // safe: every patch carries hashBefore, so applyPatches lands a per-file
    // 'stale' result instead of clobbering content that moved (pinned by the
    // "reports a per-file stale result" test in tests/unit/server-fix.test.ts).
    if (!store.report) return c.json({ error: 'no report available' }, 409);
    const body = await readJsonObject(c);
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    // Patches (which can carry full post-fix file content) are deliberately
    // withheld from the response — only planId, diffs and items go over the wire.
    const plan = await compileFixPlan(projectDir, store.report.issues, {
      issueIds,
      modeOverrides: body.modeOverrides as Record<string, FixMode> | undefined,
    });
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items } satisfies PreviewResponse);
  });

  app.post('/api/fix/apply', applyPlanHandler(ctx, 'fix-apply'));

  // Releases a previewed-but-never-applied plan (the client fires this on
  // navigation/cancel so an abandoned preview doesn't sit around until
  // PlanStore's own TTL/LRU eviction reclaims it). Deliberately does NOT take
  // the shared busy latch — see FixRoutesCtx.planStore's contract and
  // PlanStore.delete: removing an in-memory plan can't race with a scan or
  // apply, both of which only touch the filesystem and this store's own
  // take(), never this route. An unknown/already-applied/expired id is a
  // benign no-op (200), not a 404 — the client fires-and-forgets this on
  // every navigation regardless of whether the plan is still live.
  app.delete('/api/fix/plan/:planId', (c) => {
    const deleted = planStore.delete(c.req.param('planId'));
    return c.json({ deleted });
  });

  app.post('/api/ignore/preview', async (c) => {
    // Requires a report to compile against, not a 'ready' status (#33):
    // during a post-apply background rescan the store is 'scanning' but still
    // holds the previous report, and gating on 'ready' here would
    // re-serialize consecutive apply flows behind the very scan the rescan
    // chain stopped blocking on. Compiling against a possibly-stale report is
    // safe: every patch carries hashBefore, so applyPatches lands a per-file
    // 'stale' result instead of clobbering content that moved (pinned by the
    // "reports a per-file stale result" test in tests/unit/server-fix.test.ts).
    if (!store.report) return c.json({ error: 'no report available' }, 409);
    const body = await readJsonObject(c);
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    const plan = await compileIgnorePlan(projectDir, store.report.issues, issueIds);
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items } satisfies PreviewResponse);
  });

  app.post('/api/ignore/apply', applyPlanHandler(ctx, 'ignore-apply'));

  app.post('/api/sweep', async (c) => {
    // Check-and-latch must be synchronous (no await between the tryBeginOp check
    // and acting on it), otherwise two concurrent requests both pass the guard and
    // both spawn a sweep — same reasoning as /api/scan's own guard in
    // server/index.ts. Held through the awaited post-sweep rescan below (not just
    // the sweep child itself) — the sweep and its rescan are one operation, so a
    // scan or apply request arriving mid-rescan must still see 'sweep' as the
    // blocking op, not slip in once the sweep child exits.
    // #33: the background rescan chain doesn't hold the shared latch, but a
    // sweep rewriting files under a chain iteration's knip read — and the
    // stale chain landing then clobbering the sweep's own awaited rescan
    // result — is exactly the race the latch used to prevent. Same 409 wire
    // shape the latch-holding rescan produced.
    if (store.rescanActive) {
      return c.json({ error: `${BUSY_OP_LABELS.scan} in progress`, op: 'scan' }, 409);
    }
    if (!store.tryBeginOp('sweep')) {
      return c.json({ error: `${BUSY_OP_LABELS[store.activeOp!]} in progress`, op: store.activeOp }, 409);
    }
    try {
      const body = await readJsonObject(c);
      // No explicit workspace on the sweep request falls back to the last scan's
      // scope rather than defaulting to a full-project sweep.
      const workspace = typeof body.workspace === 'string' ? body.workspace : store.lastScanScope;
      // Track the sweep child so the CLI's close() can reap a still-running
      // `knip --fix` on shutdown (it can be actively rewriting/deleting files).
      const controller = store.beginSweep();
      let sweepResult: { ok: boolean; stderr?: string };
      try {
        sweepResult = await sweep(projectDir, {
          workspace,
          fixTypes: Array.isArray(body.fixTypes) ? body.fixTypes : undefined,
          allowRemoveFiles: !!body.allowRemoveFiles,
          signal: controller.signal,
        });
      } finally {
        store.endSweep(controller);
      }
      if (!sweepResult.ok) return c.json({ error: 'sweep failed', stderr: sweepResult.stderr }, 500);

      store.lastScanScope = workspace;
      store.setScanning();
      const result = await performRescan(ctx);
      // Flatten the StoreError to a string `error` (plus structured detail) so the
      // client's apiErrorMessage — which only reads a string `error` — can surface it.
      if (!result.ok) {
        return c.json(toErrorBody(result.error), 500);
      }
      return c.json({ issueCount: result.issueCount } satisfies SweepResponse);
    } finally {
      store.endOp();
    }
  });

  app.get('/api/sweep/capabilities', async (c) => {
    const caps = await probeSweepCapabilities(projectDir);
    return c.json(caps);
  });
}
