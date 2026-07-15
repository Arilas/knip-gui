import type { Hono } from 'hono';
import { runScan } from '../core/knip-runner.js';
import { compileFixPlan, compileIgnorePlan } from '../fix/compiler.js';
import type { FixMode } from '../core/types.js';
import { applyPatches, type PatchResult } from '../fix/patch.js';
import type { PlanStore } from '../fix/plan-store.js';
import { probeSweepCapabilities, runSweep } from '../fix/sweep.js';
import { readJsonObject } from './body.js';
import { runScanIntoStore } from './scan-runner.js';
import type { ReportStore, StoreError } from './store.js';

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

// Fire-and-forget rescan after a fix/ignore apply, mirroring the CLI's
// fire-and-forget initial scan (src/cli.ts) and respecting the shared busy latch:
// if a scan, sweep, or another apply is already in flight, this is a no-op (the
// in-flight op's own result — or its own subsequent rescan — will stand) and the
// route reports rescanning:false. In practice, from this function's only three
// callers below, that branch can't fire: each releases its own op's latch and
// calls this synchronously in the same tick (no intervening await), so nothing
// else can have grabbed the latch by the time tryBeginOp('scan') here runs. Kept
// as a real guard anyway rather than an assert, since it's cheap insurance
// against a future caller that isn't as careful about the gap.
// Exported for routes-ignores.ts's remove/apply route, which needs the exact
// same latch behavior after applying a remove-ignores patch — reused rather
// than duplicated.
export function triggerBackgroundRescan(ctx: FixRoutesCtx): boolean {
  if (!ctx.store.tryBeginOp('scan')) return false;
  ctx.store.setScanning();
  // Fire-and-forget: nothing awaits this, so the latch can only be released from
  // inside the promise chain itself, not a surrounding try/finally.
  void performRescan(ctx).finally(() => ctx.store.endOp());
  return true;
}

export function registerFixRoutes(app: Hono, ctx: FixRoutesCtx): void {
  const { store, planStore, projectDir, sweep = runSweep } = ctx;

  app.post('/api/fix/preview', async (c) => {
    if (store.status !== 'ready' || !store.report) return c.json({ error: 'no report available' }, 409);
    const body = await readJsonObject(c);
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    // Patches (which can carry full post-fix file content) are deliberately
    // withheld from the response — only planId, diffs and items go over the wire.
    const plan = await compileFixPlan(projectDir, store.report.issues, {
      issueIds,
      modeOverrides: body.modeOverrides as Record<string, FixMode> | undefined,
    });
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items });
  });

  app.post('/api/fix/apply', async (c) => {
    // Same synchronous check-and-latch reasoning as /api/scan and /api/sweep: no
    // await before tryBeginOp, or a concurrent request could slip through.
    if (!store.tryBeginOp('fix-apply')) {
      return c.json({ error: `${store.activeOp} in progress`, op: store.activeOp }, 409);
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
      // Released here — synchronously, with no await before triggerBackgroundRescan
      // below — so nothing can slip into the gap between this endOp() and the
      // rescan's own tryBeginOp('scan').
      store.endOp();
    }
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
  });

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
    if (store.status !== 'ready' || !store.report) return c.json({ error: 'no report available' }, 409);
    const body = await readJsonObject(c);
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    const plan = await compileIgnorePlan(projectDir, store.report.issues, issueIds);
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items });
  });

  app.post('/api/ignore/apply', async (c) => {
    // Same synchronous check-and-latch reasoning as /api/fix/apply above.
    if (!store.tryBeginOp('ignore-apply')) {
      return c.json({ error: `${store.activeOp} in progress`, op: store.activeOp }, 409);
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
      // Released synchronously, no await before triggerBackgroundRescan — see
      // /api/fix/apply above.
      store.endOp();
    }
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
  });

  app.post('/api/sweep', async (c) => {
    // Check-and-latch must be synchronous (no await between the tryBeginOp check
    // and acting on it), otherwise two concurrent requests both pass the guard and
    // both spawn a sweep — same reasoning as /api/scan's own guard in
    // server/index.ts. Held through the awaited post-sweep rescan below (not just
    // the sweep child itself) — the sweep and its rescan are one operation, so a
    // scan or apply request arriving mid-rescan must still see 'sweep' as the
    // blocking op, not slip in once the sweep child exits.
    if (!store.tryBeginOp('sweep')) {
      return c.json({ error: `${store.activeOp} in progress`, op: store.activeOp }, 409);
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
        return c.json({ error: result.error.message, code: result.error.code, stderr: result.error.stderr }, 500);
      }
      return c.json({ issueCount: result.issueCount });
    } finally {
      store.endOp();
    }
  });

  app.get('/api/sweep/capabilities', async (c) => {
    const caps = await probeSweepCapabilities(projectDir);
    return c.json(caps);
  });
}
