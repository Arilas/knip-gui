import type { Hono } from 'hono';
import { KnipError, runScan } from '../core/knip-runner.js';
import { normalize } from '../core/normalize.js';
import { getWorkspaceDirs } from '../core/workspaces.js';
import { compileFixPlan, compileIgnorePlan } from '../fix/compiler.js';
import { applyPatches } from '../fix/patch.js';
import type { PlanStore } from '../fix/plan-store.js';
import { probeSweepCapabilities, runSweep } from '../fix/sweep.js';
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

function toStoreError(e: unknown): StoreError {
  return e instanceof KnipError
    ? { code: e.code ?? 'knip-failed', message: e.message, stderr: e.stderr, exitCode: e.exitCode }
    : { code: 'internal', message: String(e) };
}

// Runs a scan and lands the outcome in the store — the shared core of both the
// awaited (sweep) and fire-and-forget (fix/ignore apply) rescan paths. Caller
// is responsible for having already set the store to 'scanning' before calling.
async function performRescan(
  ctx: FixRoutesCtx,
): Promise<{ ok: true; issueCount: number } | { ok: false; error: StoreError }> {
  const controller = ctx.store.beginScan();
  try {
    // Reuse the last scan's workspace rather than silently widening back to a
    // full-project scan (Plan 2 carried-over obligation).
    const scope = ctx.store.lastScanScope;
    const raw = await ctx.scan(ctx.projectDir, { workspace: scope, production: ctx.production, signal: controller.signal });
    const workspaces = await getWorkspaceDirs(ctx.projectDir);
    const issues = normalize(raw, workspaces);
    ctx.store.setReady({ issues, scannedAt: new Date().toISOString(), workspaces, scope, production: ctx.production });
    return { ok: true, issueCount: issues.length };
  } catch (e) {
    const err = toStoreError(e);
    ctx.store.setError(err);
    return { ok: false, error: err };
  } finally {
    ctx.store.endScan(controller);
  }
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
    const body = await c.req.json().catch(() => ({}));
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    // Patches (which can carry full post-fix file content) are deliberately
    // withheld from the response — only planId, diffs and items go over the wire.
    const plan = await compileFixPlan(projectDir, store.report.issues, {
      issueIds,
      modeOverrides: body.modeOverrides,
    });
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items });
  });

  app.post('/api/fix/apply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const plan = planStore.take(body.planId);
    if (!plan) return c.json({ error: 'unknown or already-applied plan' }, 404);
    const results = await applyPatches(projectDir, plan.patches);
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
  });

  app.post('/api/ignore/preview', async (c) => {
    if (store.status !== 'ready' || !store.report) return c.json({ error: 'no report available' }, 409);
    const body = await c.req.json().catch(() => ({}));
    const issueIds = Array.isArray(body.issueIds) ? body.issueIds : [];
    const plan = await compileIgnorePlan(projectDir, store.report.issues, issueIds);
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items });
  });

  app.post('/api/ignore/apply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const plan = planStore.take(body.planId);
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
      const body = await c.req.json().catch(() => ({}));
      // No explicit workspace on the sweep request falls back to the last scan's
      // scope rather than defaulting to a full-project sweep.
      const workspace = typeof body.workspace === 'string' ? body.workspace : store.lastScanScope;
      const sweepResult = await sweep(projectDir, {
        workspace,
        fixTypes: Array.isArray(body.fixTypes) ? body.fixTypes : undefined,
        allowRemoveFiles: !!body.allowRemoveFiles,
      });
      if (!sweepResult.ok) return c.json({ error: 'sweep failed', stderr: sweepResult.stderr }, 500);

      store.lastScanScope = workspace;
      store.setScanning();
      const result = await performRescan(ctx);
      if (!result.ok) return c.json({ error: result.error }, 500);
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
