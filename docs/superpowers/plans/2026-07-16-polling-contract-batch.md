# Polling/Contract Batch Implementation Plan (#30, #39, #40, #41)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping the full report on every 2s scan poll (#30), put the patch-target `filePath` on `PlanItem` so the client stops re-deriving it (#39), give client and server one shared, compiler-checked wire contract with a single error envelope (#40), and deduplicate the three verbatim apply routes (#41).

**Architecture:** A new `src/server/api-types.ts` module owns every request/response interface; both the Hono routes and `client/src/api.ts` import it (type-only, zero runtime cost — same cross-root pattern api.ts already uses). A slim `GET /api/status` endpoint carries `{status, scannedAt, error}`; the client polls *that* every 2s during scans and refetches the heavy report only when status/scannedAt actually change (one small sync hook mounted in the root layout). `PlanItem` gains an optional `filePath` set at compile time, which deletes `patchFileForIssue` and the join/attribution fallbacks in `apply-flow.ts`.

**Tech Stack:** TypeScript, Hono, TanStack Query v5, vitest. No new dependencies.

## Global Constraints

- pnpm 10 via corepack (`pnpm test`, `pnpm run typecheck`); Node >= 20.
- The busy-latch invariant everywhere: NO `await` between a `tryBeginOp` check and acting on it (see `src/server/store.ts:60-74`).
- 409 bodies must keep the machine-readable `op` field verbatim (`op: store.activeOp`) — tests assert it.
- `/api/report`'s response shape (`{status, report?, error?}`, `error` as a structured `StoreError`) does NOT change — SetupScreen/ReportGate depend on the structured error. Only `POST /api/scan`'s *failure* body is flattened.
- Wire types live in `src/server/api-types.ts`; the client imports them `import type` only (Vite elides them — keep it that way, no value imports from server code).
- Run `pnpm run typecheck` before every commit — it covers server, client, and tests tsconfigs.

## File Structure

- **Create** `src/server/api-types.ts` — all request/response interfaces + the error envelope.
- **Modify** `src/server/index.ts` — flatten scan-failure body; add `GET /api/status`; type route payloads.
- **Modify** `src/server/routes-fix.ts` — extract `applyPlanHandler`; type payloads.
- **Modify** `src/server/routes-ignores.ts` — use `applyPlanHandler`.
- **Modify** `src/fix/compiler.ts` — `PlanItem.filePath`.
- **Modify** `client/src/api.ts` — import wire types; add `getStatus`.
- **Modify** `client/src/state/queries.ts` — `useStatus`, `useReportStatusSync`, de-poll `useReport`.
- **Modify** `client/src/router.tsx` — mount the sync hook in `RootLayout`.
- **Modify** `client/src/lib/apply-flow.ts` — consume `PlanItem.filePath`; delete `patchFileForIssue`.
- **Modify** `client/src/components/pages/ReviewPage.tsx` — `zippedItems` from `item.filePath`.
- **Tests:** `tests/unit/server.test.ts`, `tests/unit/server-fix.test.ts`, `tests/unit/ignores-endpoint.test.ts`, `tests/unit/compiler.test.ts`, `tests/client/apply-flow.test.ts`, `tests/client/queries-invalidation.test.ts`.

---

### Task 1: `src/server/api-types.ts` + flattened scan-failure envelope (#40)

**Files:**
- Create: `src/server/api-types.ts`
- Modify: `src/server/index.ts:183` (scan failure body)
- Modify: `client/src/api.ts` (import the shared types, delete local duplicates)
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Produces: `ErrorBody`, `ReportResponse`, `StatusResponse`, `ScanResponse`, `PreviewResponse`, `ApplyResponse`, `SweepResponse` — imported by Tasks 2 and 5 and by `client/src/api.ts`.

- [ ] **Step 1: Write the failing test** — in `tests/unit/server.test.ts`, inside `describe('scan + report + file')`, add (model the failing-scan setup on the existing `'scan failure surfaces error payload'` test at line 255 — same injected failing `scan`):

```ts
it('a failed POST /api/scan returns the flat error envelope (string error, code, stderr)', async () => {
  const { app, token } = createServer({
    projectDir: '/tmp/nowhere',
    scan: async () => ({ ok: false as const, error: { code: 'knip-failed', message: 'knip exited 7', stderr: 'stack...', exitCode: 7 } }),
  });
  const res = await app.request('/api/scan', { method: 'POST', headers: { 'x-knip-gui-token': token }, body: '{}' });
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.error).toBe('knip exited 7');       // string, not an object
  expect(body.code).toBe('knip-failed');
  expect(body.stderr).toBe('stack...');
});
```

Copy the exact `scan` stub shape from the neighboring tests in that file (they already build `{ ok: false, error: {...} }` results — reuse their helper if one exists).

- [ ] **Step 2: Run it — must FAIL** — `pnpm exec vitest run tests/unit/server.test.ts` → the new test fails on `body.error` being an object.

- [ ] **Step 3: Create `src/server/api-types.ts`:**

```ts
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
```

- [ ] **Step 4: Flatten the scan-failure body in `src/server/index.ts`.** Replace line 183:

```ts
      if (!result.ok) return c.json({ status: 'error', error: result.error }, 500);
```

with:

```ts
      // Flat ErrorBody (api-types.ts), matching /api/sweep: apiErrorMessage
      // client-side only surfaces a string `error`. The structured StoreError
      // still lands in the store and is served by /api/report for SetupScreen.
      if (!result.ok) {
        return c.json({ error: result.error.message, code: result.error.code, stderr: result.error.stderr }, 500);
      }
```

Also add to index.ts's imports: `import type { ReportResponse, ScanResponse } from './api-types.js';` and type the two success payloads:
- scan success (line 184): `return c.json({ status: 'ready', issueCount: result.issueCount } satisfies ScanResponse);`
- report route (line 190-192): `app.get('/api/report', (c) => c.json({ status: store.status, report: store.report, error: store.error } satisfies ReportResponse));`

- [ ] **Step 5: Point `client/src/api.ts` at the shared module.** Delete the local `ReportResponse`, `ScanResponse`, `PreviewResponse`, `ApplyResponse`, `SweepResponse` interface declarations and add to the type imports at the top:

```ts
import type {
  ApplyResponse,
  PreviewResponse,
  ReportResponse,
  ScanResponse,
  StatusResponse,
  SweepResponse,
} from '../../src/server/api-types.js';
```

and re-export them so existing importers keep working (api.ts already ends with a type re-export line — extend it):

```ts
export type { ReportResponse, ScanResponse, PreviewResponse, ApplyResponse, SweepResponse, StatusResponse };
```

(`StatusResponse` is unused until Task 5 — exporting it now is fine.)

- [ ] **Step 6: Run tests + typecheck** — `pnpm exec vitest run tests/unit/server.test.ts && pnpm run typecheck`. Expected: PASS. If any *other* test asserted the old `{status:'error', error:{…}}` POST body (grep: `grep -rn "status.*error" tests/unit/server*.test.ts`), update it to the flat envelope — but note the two existing scan-failure tests (lines 255, 271) assert `GET /api/report` after the failed scan, which is unchanged.

- [ ] **Step 7: Full suite** — `pnpm test`. Expected: all green (client `tests/client/api.test.ts` exercises apiErrorMessage against `{error, stderr}` shapes — unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/server/api-types.ts src/server/index.ts client/src/api.ts tests/unit/server.test.ts
git commit -m "arch: shared api-types module; flatten POST /api/scan failure to the ErrorBody envelope (#40)"
```

---

### Task 2: Deduplicate the three apply routes (#41)

**Files:**
- Modify: `src/server/routes-fix.ts:79-103` and `:128-150`
- Modify: `src/server/routes-ignores.ts:34-57`
- Test: existing `tests/unit/server-fix.test.ts` + `tests/unit/ignores-endpoint.test.ts` (pure refactor — no new tests; the three routes' behavior is already pinned, including 409 `op` fields and the 404 unknown-plan path)

**Interfaces:**
- Produces: `applyPlanHandler(ctx: FixRoutesCtx, op: BusyOp): (c: Context) => Promise<Response>` exported from `routes-fix.ts`, consumed by `routes-ignores.ts`.

- [ ] **Step 1: Extract the handler factory in `routes-fix.ts`.** Add (above `registerFixRoutes`), replacing nothing yet:

```ts
// The one apply handler all three plan-consuming routes share (#41): latch →
// planStore.take → applyPatches → endOp → triggerBackgroundRescan. The latch
// invariants live HERE, once: no await between tryBeginOp and acting on it,
// and endOp() released synchronously with no await before
// triggerBackgroundRescan's own tryBeginOp('scan') — nothing can slip into
// that gap. Exported for routes-ignores.ts.
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
```

Imports to add in routes-fix.ts: `import type { Context } from 'hono';` (extend the existing hono import), `type BusyOp` from `./store.js` (extend existing import), `import type { ApplyResponse } from './api-types.js';`.

Behavioral subtlety to preserve: in the current code the body is read AFTER the latch is taken, and the latch check itself is the first statement. The factory above preserves exactly that order. Do not "improve" it by reading the body first — that would put an `await` before the latch check.

- [ ] **Step 2: Replace the three route bodies.**

In `routes-fix.ts`:
```ts
  app.post('/api/fix/apply', applyPlanHandler(ctx, 'fix-apply'));
  app.post('/api/ignore/apply', applyPlanHandler(ctx, 'ignore-apply'));
```
(delete the two inline handlers at lines 79-103 and 128-150, keeping their route paths).

In `routes-ignores.ts`, replace the `/api/ignores/remove/apply` handler (lines 34-57) with:
```ts
  app.post('/api/ignores/remove/apply', applyPlanHandler(ctx, 'ignore-remove-apply'));
```
Add `applyPlanHandler` to the existing `./routes-fix.js` import; remove now-unused imports (`applyPatches`, `PatchResult`, `BUSY_OP_LABELS`, `readJsonObject`) — run typecheck to catch leftovers.

- [ ] **Step 3: Run the pinning tests** — `pnpm exec vitest run tests/unit/server-fix.test.ts tests/unit/ignores-endpoint.test.ts`. Expected: PASS with zero test edits (if a test fails, the refactor changed behavior — fix the refactor, not the test).

- [ ] **Step 4: Full suite + typecheck** — `pnpm test && pnpm run typecheck`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes-fix.ts src/server/routes-ignores.ts
git commit -m "arch: one applyPlanHandler for the three apply routes (#41)"
```

---

### Task 3: `PlanItem.filePath` — server half (#39)

**Files:**
- Modify: `src/fix/compiler.ts`
- Test: `tests/unit/compiler.test.ts`

**Interfaces:**
- Produces: `PlanItem` gains `filePath?: string` — "the file this issue's patch lands in (the knip config file for ignore-mode config edits; the workspace package.json for dependency fixes). Unset only when it cannot be known (unknown-issue, no/code config)." Task 4 consumes this.

- [ ] **Step 1: Write the failing tests** in `tests/unit/compiler.test.ts` (adapt fixture setup from the existing tests in that file — they already compile plans against tmp-dir fixtures; reuse their helpers):

```ts
it('every PlanItem carries the filePath its patch lands in', async () => {
  // Use an existing fixture arrangement from this file with: one exports issue
  // (strip-export), one dependencies issue, one files issue (delete-file).
  const plan = await compileFixPlan(dir, issues, { issueIds: issues.map((i) => i.id) });
  const byId = new Map(plan.items.map((i) => [i.issueId, i]));
  expect(byId.get(exportIssue.id)?.filePath).toBe(exportIssue.filePath);
  expect(byId.get(depIssue.id)?.filePath).toBe('package.json'); // root workspace pkg
  expect(byId.get(fileIssue.id)?.filePath).toBe(fileIssue.filePath);
});

it('ignore-plan config-edit items carry the config file path', async () => {
  // fixture with a knip.json and one ignorable dependencies issue
  const plan = await compileIgnorePlan(dir, [depIssue], [depIssue.id]);
  expect(plan.items[0]?.filePath).toBe('knip.json');
});

it('unknown-issue items have no filePath', async () => {
  const plan = await compileFixPlan(dir, [], { issueIds: ['nope'] });
  expect(plan.items[0]?.ok).toBe(false);
  expect(plan.items[0]?.filePath).toBeUndefined();
});
```

- [ ] **Step 2: Run — must FAIL** — `pnpm exec vitest run tests/unit/compiler.test.ts` (filePath undefined everywhere).

- [ ] **Step 3: Implement.** In `src/fix/compiler.ts`:

1. Extend the interface (line 28):
```ts
export interface PlanItem {
  issueId: string;
  ok: boolean;
  reason?: string;
  /**
   * The file this issue's patch lands in — the source file for source
   * transforms, the owning workspace's package.json for dependency fixes,
   * the knip config file for ignore-mode config edits. Unset only when it
   * cannot be known: unknown-issue, or no/code-config ignore failures.
   * The client's join/attribution logic (apply-flow.ts) reads this instead
   * of re-deriving it from the issue (#39).
   */
  filePath?: string;
}
```

2. Set it at every push site. Exhaustive list (line numbers pre-edit):
   - `compileFixPlan`: line 156 unknown-issue → leave unset. Line 160 not-fixable → `filePath: issue.filePath`. Line 165 invalid-mode → `filePath: issue.filePath`. Line 193 no-duplicate-members → `filePath: issue.filePath`. Line 215 superseded-by-delete → `filePath` (the loop's `filePath` var). Lines 221/227 delete not-found/ok → `filePath`. Line 235 source file-not-found → `filePath`. Lines 265/267 dep ok/fail → `filePath: pkgPath`.
   - `runSourceChain` (line 128): items built there → `filePath` (add it to both the failed and ok branches; `filePath` is already a parameter of the function).
   - `compileIgnorePlan`: line 318 unknown-issue → unset. Lines 326/372 not-ignorable → `filePath: issue.filePath`. Lines 379/381 code-config/no-config → unset. Config-edit loop (lines 392-401): hoist `const relPath = relative(projectDir, abs);` to just after `const abs = config.path!;` (line 384) and use `filePath: relPath` on both the ok and fail pushes; the later patch push (line 403) then reuses the hoisted `relPath`. Tag-op loop lines 435/437 → `filePath`. File-not-found line 415 → `filePath`.
   - `compileRemoveIgnoresPlan`: line 481 code/none → unset. Lines 489/491 → hoist `const relPath = relative(projectDir, abs);` up beside `const abs = config.path!;` and use `filePath: relPath` on both.

- [ ] **Step 4: Run — must PASS** — `pnpm exec vitest run tests/unit/compiler.test.ts`.

- [ ] **Step 5: Full suite + typecheck** — `pnpm test && pnpm run typecheck` (the field is optional; nothing else should break).

- [ ] **Step 6: Commit**

```bash
git add src/fix/compiler.ts tests/unit/compiler.test.ts
git commit -m "arch: PlanItem carries the patch-target filePath (#39, server half)"
```

---

### Task 4: Client consumes `PlanItem.filePath` (#39)

**Files:**
- Modify: `client/src/lib/apply-flow.ts` (joinResults, appliedOkIssueIds, buildApplyActivityEntry; DELETE patchFileForIssue + DEP_TYPES)
- Modify: `client/src/components/pages/ReviewPage.tsx:244-252` (zippedItems)
- Test: `tests/client/apply-flow.test.ts`

**Interfaces:**
- Consumes: `PlanItem.filePath` from Task 3.
- Produces (signature changes — update ALL call sites in the same task):
  - `joinResults(previewDiffs: DiffEntry[], applyResults: PatchResult[], planItems: PlanItem[]): FileResultRow[]` (drops the `issues` param)
  - `appliedOkIssueIds(planItems: PlanItem[], rows: FileResultRow[]): string[]` (drops the `issues` param)
  - `buildApplyActivityEntry(diffs, items, results, planIssues, kind, fallbackSummary, at)` — signature UNCHANGED (`planIssues` still feeds `summaryByType`), internals updated.

- [ ] **Step 1: Update the tests first** in `tests/client/apply-flow.test.ts`: every `joinResults(...)`/`appliedOkIssueIds(...)` call drops its `issues` argument, and every fabricated `PlanItem` in those tests gains a `filePath` matching what the old issue-lookup produced (compile-failed items keep a filePath so their row shows it; add one new case asserting a `filePath`-less failed item joins as `'unknown file'`). Add one regression test pinning the no-patch fallback:

```ts
it('an ok item whose file produced no patch counts as applied only when every patch applied ok', () => {
  const rows: FileResultRow[] = [{ filePath: 'a.ts', status: 'ok' }];
  // knip.json edit compiled ok but was a no-op (entry already present) — no patch row for it
  const items: PlanItem[] = [{ issueId: 'i1', ok: true, filePath: 'knip.json' }];
  expect(appliedOkIssueIds(items, rows)).toEqual(['i1']);
  const rowsWithFailure: FileResultRow[] = [{ filePath: 'a.ts', status: 'stale' }];
  expect(appliedOkIssueIds(items, rowsWithFailure)).toEqual([]);
});
```

- [ ] **Step 2: Run — must FAIL** — `pnpm exec vitest run tests/client/apply-flow.test.ts` (signature mismatches).

- [ ] **Step 3: Implement in `apply-flow.ts`.**

`joinResults` (replace lines 107-131; doc comment updated to say filePath now rides on PlanItem):
```ts
export function joinResults(
  previewDiffs: DiffEntry[],
  applyResults: PatchResult[],
  planItems: PlanItem[],
): FileResultRow[] {
  const resultByFile = new Map(applyResults.map((r) => [r.filePath, r]));
  const diffRows: FileResultRow[] = previewDiffs.map(({ filePath }): FileResultRow => {
    const result = resultByFile.get(filePath);
    if (!result) return { filePath, status: 'missing', reason: 'no apply result received for this file' };
    if (result.ok) return { filePath, status: 'ok' };
    return { filePath, status: result.reason ?? 'io-error', reason: result.detail };
  });

  const compileFailedRows: FileResultRow[] = planItems
    .filter((item) => !item.ok)
    .map((item) => ({
      filePath: item.filePath ?? 'unknown file',
      status: 'compile-failed' as const,
      reason: item.reason,
    }));

  return [...diffRows, ...compileFailedRows];
}
```

DELETE `DEP_TYPES` (line 200) and `patchFileForIssue` (lines 201-214) entirely.

`appliedOkIssueIds` (replace lines 230-251; keep the no-patch fallback but now it is precise — an ok item whose file emitted no patch, e.g. a no-op config edit — rather than "can't attribute"):
```ts
export function appliedOkIssueIds(planItems: PlanItem[], rows: FileResultRow[]): string[] {
  const patchRows = rows.filter((r) => r.status !== 'compile-failed');
  const patchFiles = new Set(patchRows.map((r) => r.filePath));
  const okFiles = new Set(patchRows.filter((r) => r.status === 'ok').map((r) => r.filePath));
  const allPatchesOk = patchRows.every((r) => r.status === 'ok');

  const ids: string[] = [];
  for (const item of planItems) {
    if (!item.ok || item.filePath === undefined) continue;
    const applied = patchFiles.has(item.filePath) ? okFiles.has(item.filePath) : allPatchesOk;
    if (applied) ids.push(item.issueId);
  }
  return ids;
}
```

`buildApplyActivityEntry` internals (lines 296-301): `joinResults(diffs, results, items)` and `appliedOkIssueIds(items, joinedRows)`; `planIssues` still feeds `summaryByType`.

- [ ] **Step 4: Update ReviewPage.** `zippedItems` (lines 244-252) no longer needs the issue lookup:
```ts
  const zippedItems: RailPlanItem[] = useMemo(() => {
    if (flow.status === 'idle' || flow.status === 'previewing' || flow.status === 'failed') return [];
    return flow.items.map((item) => ({
      filePath: item.filePath ?? 'unknown file',
      ok: item.ok,
      reason: item.reason,
    }));
  }, [flow]);
```
`planIssuesRef` stays — it still feeds `buildApplyActivityEntry`'s summary. Check `client/src/components/flows/RemoveIgnoreDialog.tsx` for `joinResults` calls (grep `joinResults\|appliedOkIssueIds` across client/src) and drop the `issues` argument there too if present.

- [ ] **Step 5: Run — must PASS** — `pnpm exec vitest run tests/client/apply-flow.test.ts tests/client/review.test.ts && pnpm run typecheck` (typecheck is what catches any missed call site).

- [ ] **Step 6: Full suite** — `pnpm test`. Expected: green.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/apply-flow.ts client/src/components/pages/ReviewPage.tsx tests/client/apply-flow.test.ts
git commit -m "arch: client reads PlanItem.filePath; delete patchFileForIssue re-derivation (#39)"
```

---

### Task 5: `GET /api/status` + switch the 2s poll to it (#30)

**Files:**
- Modify: `src/server/index.ts` (new route)
- Modify: `client/src/api.ts` (`getStatus`)
- Modify: `client/src/state/queries.ts` (`useStatus`, `useReportStatusSync`, de-poll `useReport`, invalidate status alongside report)
- Modify: `client/src/router.tsx` (`RootLayout` mounts the sync hook)
- Test: `tests/unit/server.test.ts`, `tests/client/queries-invalidation.test.ts`

**Interfaces:**
- Consumes: `StatusResponse` from Task 1.
- Produces: `useStatus(): UseQueryResult<StatusResponse>`; `useReportStatusSync(): void`; pure helper `reportOutOfSync(status: StatusResponse | undefined, cached: ReportResponse | undefined): boolean` exported from `queries.ts` for unit testing.

- [ ] **Step 1: Server test first** — in `tests/unit/server.test.ts`, `describe('scan + report + file')`:

```ts
it('GET /api/status returns status + scannedAt without the report body', async () => {
  // reuse the file's standard happy-path scan setup, then:
  const res = await app.request('/api/status', { headers: { 'x-knip-gui-token': token } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ready');
  expect(typeof body.scannedAt).toBe('string');
  expect('report' in body).toBe(false);
});
```

- [ ] **Step 2: Run — must FAIL** (404 JSON envelope from the SPA fallback's `/api/*` carve-out).

- [ ] **Step 3: Add the route** in `src/server/index.ts`, directly below the `/api/report` route:

```ts
  // The slim poll target (#30): everything the client needs to decide whether
  // to refetch the multi-MB /api/report — and nothing else. scannedAt is the
  // current report's timestamp (absent before the first successful scan).
  app.get('/api/status', (c) =>
    c.json({ status: store.status, scannedAt: store.report?.scannedAt, error: store.error } satisfies StatusResponse),
  );
```
(add `StatusResponse` to the api-types import). Run Step 1's test → PASS.

- [ ] **Step 4: Client — api.ts:**

```ts
export function getStatus(): Promise<StatusResponse> {
  return apiFetch<StatusResponse>('/api/status');
}
```

- [ ] **Step 5: Client — queries.ts.** Replace the `useReport` block (lines 38-46) with:

```ts
export const statusQueryKey = ['status'] as const;

// The 2s scan poll now hits the slim /api/status instead of re-downloading
// the full report every tick (#30). useReportStatusSync (mounted once in
// RootLayout) invalidates the report query when status/scannedAt move, so
// useReport itself no longer polls.
export function useStatus() {
  return useQuery({
    queryKey: statusQueryKey,
    queryFn: getStatus,
    refetchInterval: (query) => (query.state.data?.status === 'scanning' ? 2000 : false),
  });
}

/**
 * True when the cached report no longer matches what /api/status reports —
 * either the lifecycle status moved (ready -> scanning, scanning -> error, …)
 * or a new scan landed (scannedAt changed). No cached report yet is NOT out
 * of sync: the report query's own first fetch covers that.
 */
export function reportOutOfSync(
  status: StatusResponse | undefined,
  cached: ReportResponse | undefined,
): boolean {
  if (!status || !cached) return false;
  return cached.status !== status.status || cached.report?.scannedAt !== status.scannedAt;
}

/** Mounted ONCE in RootLayout: refetch the heavy report only when the slim status says it moved. */
export function useReportStatusSync(): void {
  const queryClient = useQueryClient();
  const { data: status } = useStatus();
  useEffect(() => {
    if (reportOutOfSync(status, queryClient.getQueryData<ReportResponse>(reportQueryKey))) {
      void queryClient.invalidateQueries({ queryKey: reportQueryKey });
    }
  }, [queryClient, status]);
}

export function useReport() {
  return useQuery({
    queryKey: reportQueryKey,
    queryFn: getReport,
    // No refetchInterval — useReportStatusSync drives refetches. staleTime
    // keeps window-refocus from re-downloading a multi-MB body that
    // /api/status hasn't said is stale (invalidateQueries bypasses staleTime,
    // so sync-driven refetches are unaffected).
    staleTime: 30_000,
  });
}
```

Imports to add: `useEffect` from `react`; `getStatus` plus `type ReportResponse, type StatusResponse` from `../api.js`.

Then make every write path nudge the status query too, so polling starts within one render of a mutation instead of waiting for a stale status fetch:
- in `invalidateAfterWrite` (line 92): add `queryClient.invalidateQueries({ queryKey: statusQueryKey });`
- in `useScanMutation.onSettled` (line 114): `onSettled: () => { queryClient.invalidateQueries({ queryKey: reportQueryKey }); queryClient.invalidateQueries({ queryKey: statusQueryKey }); },`

`useBusy` (line 211-217): switch its report read to the status query — `const { data } = useStatus();` (same `data?.status === 'scanning'` check; StatusResponse carries `status` identically). Everything else (`ReportGate`, ReviewPage's `rescanning`) stays on `useReport` — the sync hook keeps that data current at transitions.

- [ ] **Step 6: Mount the sync hook.** In `client/src/router.tsx`'s `RootLayout` component (the component rendering `SidebarProvider`, ends line 196), add as its first hook line: `useReportStatusSync();` (import from `./state/queries.js`).

- [ ] **Step 7: Unit-test the sync decision** in `tests/client/queries-invalidation.test.ts` (pure function — no react needed):

```ts
import { reportOutOfSync } from '../../client/src/state/queries.js';

describe('reportOutOfSync', () => {
  const ready = (scannedAt: string) =>
    ({ status: 'ready', report: { scannedAt, issues: [], workspaces: [], production: false } }) as ReportResponse;

  it('false with no status yet or no cached report yet', () => {
    expect(reportOutOfSync(undefined, ready('t1'))).toBe(false);
    expect(reportOutOfSync({ status: 'ready', scannedAt: 't1' }, undefined)).toBe(false);
  });
  it('false when status and scannedAt both match', () => {
    expect(reportOutOfSync({ status: 'ready', scannedAt: 't1' }, ready('t1'))).toBe(false);
  });
  it('true when the lifecycle status moved', () => {
    expect(reportOutOfSync({ status: 'scanning', scannedAt: 't1' }, ready('t1'))).toBe(true);
  });
  it('true when a new scan landed', () => {
    expect(reportOutOfSync({ status: 'ready', scannedAt: 't2' }, ready('t1'))).toBe(true);
  });
});
```

- [ ] **Step 8: Run** — `pnpm exec vitest run tests/client/queries-invalidation.test.ts tests/unit/server.test.ts && pnpm run typecheck`. Expected: PASS.

- [ ] **Step 9: Full suite, then e2e** — `pnpm test`, then `pnpm run test:e2e`. The e2e suite is the real gate for this task: `codepane-crash.spec.ts` asserts a rescan is observably in flight mid-poll (its own probe hits `/api/report` directly via `page.request` — still valid), and `smoke`/`review`/`ignore` specs all wait on post-apply rescans to settle, which now flow through status polling + sync-driven report refetch. If a spec times out waiting for the tree to refresh after apply, the sync hook isn't invalidating (check that RootLayout actually mounts it and that `invalidateAfterWrite` nudges `statusQueryKey`). Update the stale comment at `codepane-crash.spec.ts:74` ("/api/report polling interval") to name `/api/status`.

- [ ] **Step 10: Commit**

```bash
git add src/server/index.ts client/src/api.ts client/src/state/queries.ts client/src/router.tsx tests/unit/server.test.ts tests/client/queries-invalidation.test.ts tests/e2e/codepane-crash.spec.ts
git commit -m "perf: slim GET /api/status drives the scan poll; report refetches only on change (#30)"
```

---

## Out of scope (deliberately)

- `setScanning()` clearing `store.report` — the stale report during rescans is what keeps pages populated (ReportGate's rescan exemption); the payload problem is solved by not re-downloading it.
- `staleTime` for gitStatus — it genuinely changes behind the app's back; untouched.
- SSE — per the design errata, revisit only when watch mode (#18) lands; `/api/status` is the stepping stone.
- Compiler per-file parse batching (#32) and op-chain dedup (#42) — next batch ("compiler shape").
