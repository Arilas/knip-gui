import type { Hono } from 'hono';
import { runScan } from '../core/knip-runner.js';
import { compileFixPlan, compileIgnorePlan } from '../fix/compiler.js';
import type { FixMode } from '../core/types.js';
import { applyPatches } from '../fix/patch.js';
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
// fire-and-forget initial scan (src/cli.ts) and respecting /api/scan's latch:
// if a scan is already in flight, this is a no-op (the in-flight scan's own
// result will stand) and the route reports rescanning:false.
// Exported for routes-ignores.ts's remove/apply route, which needs the exact
// same latch behavior after applying a remove-ignores patch — reused rather
// than duplicated.
export function triggerBackgroundRescan(ctx: FixRoutesCtx): boolean {
  if (ctx.store.status === 'scanning') return false;
  ctx.store.setScanning();
  void performRescan(ctx);
  return true;
}

export function registerFixRoutes(app: Hono, ctx: FixRoutesCtx): void {
  const { store, planStore, projectDir, sweep = runSweep } = ctx;
  // Synchronous latch for /api/sweep, mirroring /api/scan's check-then-latch
  // pattern: set before the route's first await, cleared in `finally`, so two
  // concurrent sweep POSTs can't both pass the guard and both spawn a sweep.
  // Scoped to this call of registerFixRoutes (i.e. per createServer instance)
  // rather than module-level, so unrelated server instances in the same
  // process (e.g. parallel tests) never share this latch.
  let sweeping = false;

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
    const body = await readJsonObject(c);
    const plan = planStore.take(typeof body.planId === 'string' ? body.planId : '');
    if (!plan) return c.json({ error: 'unknown or already-applied plan' }, 404);
    const results = await applyPatches(projectDir, plan.patches);
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
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
    const body = await readJsonObject(c);
    const plan = planStore.take(typeof body.planId === 'string' ? body.planId : '');
    if (!plan) return c.json({ error: 'unknown or already-applied plan' }, 404);
    const results = await applyPatches(projectDir, plan.patches);
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
  });

  app.post('/api/sweep', async (c) => {
    // Check-and-latch must be synchronous (no await between the status/latch
    // check and setting `sweeping`), otherwise two concurrent requests both
    // pass the guard and both spawn a sweep — same reasoning as /api/scan's
    // own single-flight guard in server/index.ts.
    if (store.status === 'scanning' || sweeping) return c.json({ error: 'scan in progress' }, 409);
    sweeping = true;
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
      sweeping = false;
    }
  });

  app.get('/api/sweep/capabilities', async (c) => {
    const caps = await probeSweepCapabilities(projectDir);
    return c.json(caps);
  });
}
