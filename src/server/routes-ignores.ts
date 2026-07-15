import type { Hono } from 'hono';
import { compileRemoveIgnoresPlan } from '../fix/compiler.js';
import { applyPatches, type PatchResult } from '../fix/patch.js';
import { listIgnores } from '../ignore/config-writer.js';
import { readJsonObject } from './body.js';
import { triggerBackgroundRescan, type FixRoutesCtx } from './routes-fix.js';

// Ignored page's server surface (Task 5, UX overhaul): list the project's
// current ignore entries, and preview/apply removing a subset of them.
// Reuses FixRoutesCtx as-is (same projectDir/scan/store/planStore shape
// routes-fix.ts already needs) rather than a bespoke ctx type, so the SAME
// ctx object server/index.ts builds for registerFixRoutes can be passed here
// too — and so triggerBackgroundRescan (also reused, not reimplemented) has
// everything it needs.
export function registerIgnoresRoutes(app: Hono, ctx: FixRoutesCtx): void {
  const { projectDir, planStore, store } = ctx;

  app.get('/api/ignores', async (c) => {
    const result = await listIgnores(projectDir);
    return c.json(result);
  });

  app.post('/api/ignores/remove/preview', async (c) => {
    const body = await readJsonObject(c);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    // Patches are withheld from the response, same as /api/fix/preview and
    // /api/ignore/preview — only planId, diffs and items go over the wire.
    const plan = await compileRemoveIgnoresPlan(projectDir, entries);
    planStore.put(plan);
    return c.json({ planId: plan.planId, diffs: plan.diffs, items: plan.items });
  });

  app.post('/api/ignores/remove/apply', async (c) => {
    // Same synchronous check-and-latch reasoning as routes-fix.ts's apply routes:
    // no await before tryBeginOp, or a concurrent request could slip through.
    if (!store.tryBeginOp('ignore-remove-apply')) {
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
      // routes-fix.ts's apply routes.
      store.endOp();
    }
    const failedItems = plan.items.filter((i) => !i.ok);
    const rescanning = triggerBackgroundRescan(ctx);
    return c.json({ results, failedItems, rescanning });
  });
}
