import type { Hono } from 'hono';
import { compileRemoveIgnoresPlan } from '../fix/compiler.js';
import { listIgnores } from '../ignore/config-writer.js';
import { applyPlanHandler, type FixRoutesCtx } from './routes-fix.js';
import { readJsonObject } from './body.js';

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

  app.post('/api/ignores/remove/apply', applyPlanHandler(ctx, 'ignore-remove-apply'));
}
