# Issue Burndown #1–#12 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issues #1–#12 (server robustness/security + client bugs/UX), one commit per issue, tests per fix, browser verification for UI-visible changes.

**Architecture:** Three independent batches with disjoint file sets so they can be implemented in parallel: (A) server (`src/**`, `tests/unit|integration`), (B) review-flow client (`client/src/state/*`, `ReviewPage`, `api.ts`), (C) misc client (`GitFooter`, `CommitDialog`, `CodePane`, `badge`). Batch A also defines the `DELETE /api/fix/plan/:planId` route that Batch B's cancel wiring calls.

**Tech Stack:** Hono (server), React 19 + zustand + react-query (client), vitest (`npm test`), `npm run typecheck`. Test style: `tests/unit/server-fix.test.ts` builds a server via `createServer` with injected `scan`/`sweep` fakes and calls `app.request(...)`; client store/lib tests are pure vitest against zustand vanilla stores.

## Global Constraints

- One commit per issue, message format `fix: <what> (#N)` / `feat: <what> (#N)` — no `Fixes #N` auto-close keywords (issues are closed manually with a comment after verification).
- `npm test` and `npm run typecheck` must pass after every task.
- Never weaken existing behavior guarded by tests; extend tests instead.
- Comments follow the codebase's dense "why, not what" style.

---

## Batch A — server (issues #1–#5)

### Task A1: Shared busy latch across scan/sweep/apply (#1)

**Files:**
- Modify: `src/server/store.ts` — add op-latch API
- Modify: `src/server/index.ts` (`/api/scan`)
- Modify: `src/server/routes-fix.ts` (`/api/fix/apply`, `/api/ignore/apply`, `/api/sweep`, `triggerBackgroundRescan`)
- Modify: `src/server/routes-ignores.ts` (remove-apply route, if it applies patches)
- Test: `tests/unit/server-fix.test.ts` (extend)

**Interfaces (Produces):** `ReportStore.tryBeginOp(op: BusyOp): boolean` and `ReportStore.endOp(): void`, `type BusyOp = 'scan' | 'sweep' | 'fix-apply' | 'ignore-apply' | 'ignore-remove-apply'`; busy routes answer `409 {error: '<op> in progress', op: '<op>'}`.

Steps:
- [ ] Add `activeOp?: BusyOp` + `tryBeginOp`/`endOp` to ReportStore (synchronous check-and-set; `endOp` clears unconditionally — single-threaded route handlers).
- [ ] `/api/scan`: replace `store.status === 'scanning'` guard with `tryBeginOp('scan')`; `endOp()` in `finally` after `runScanIntoStore` settles.
- [ ] `/api/sweep`: replace local `sweeping` latch with `tryBeginOp('sweep')`; keep everything else; `endOp()` in `finally` **before** the awaited rescan? No — the sweep's rescan must stay under the latch: hold `sweep` op through the awaited `performRescan`, release in `finally`.
- [ ] `/api/fix/apply` + `/api/ignore/apply` (+ ignore-remove apply): `tryBeginOp` at top (409 on conflict), `endOp()` synchronously right before `triggerBackgroundRescan(ctx)` (no `await` between endOp and the rescan's own tryBeginOp, so nothing can interleave).
- [ ] `triggerBackgroundRescan`: `tryBeginOp('scan')` instead of `status === 'scanning'`; release via `.finally(() => store.endOp())` on the fire-and-forget promise.
- [ ] Tests: stalled sweep (injected `sweep` that blocks on a deferred) → concurrent `/api/fix/apply` gets 409 `sweep in progress`; stalled apply (injected fs? use compile+apply of a plan against a slow store — simpler: stalled scan via injected `scan`) → `/api/sweep` 409; two concurrent scans still 409 (existing test keeps passing).
- [ ] `npm test` + typecheck, commit `fix: share one busy latch across scan/sweep/apply routes (#1)`.

### Task A2: PlanStore cap/TTL + DELETE route (#2)

**Files:**
- Modify: `src/fix/plan-store.ts`
- Modify: `src/server/routes-fix.ts` — `DELETE /api/fix/plan/:planId`
- Test: `tests/unit/server-fix.test.ts` (extend) + new `tests/unit/plan-store.test.ts`

**Interfaces (Produces):** `new PlanStore(opts?: {maxPlans?: number; ttlMs?: number; now?: () => number})` (defaults 20 plans / 15 min; `now` injectable for tests); `PlanStore.delete(planId: string): boolean`; route `DELETE /api/fix/plan/:planId` → `200 {deleted: boolean}` (deleting an unknown/expired id is a benign no-op, not a 404 — the client fires and forgets).

Steps:
- [ ] PlanStore: keep insertion-ordered `Map<string, {plan, at}>`; `put` prunes expired (TTL) then evicts oldest beyond `maxPlans`; `take`/`delete` also treat an expired entry as absent.
- [ ] Unit tests: eviction order, TTL expiry via injected `now`, delete semantics, take-after-expiry returns undefined.
- [ ] Route + server test (`DELETE` on previewed plan → apply gets 404 `unknown or already-applied plan`).
- [ ] Commit `fix: cap PlanStore (LRU+TTL) and add DELETE /api/fix/plan/:planId (#2)`.

### Task A3: Distinct maxBuffer-overflow error (#3)

**Files:**
- Modify: `src/core/knip-runner.ts`
- Test: `tests/integration/knip-runner.test.ts` or new unit test with a fake child? — `runScan` shells out for real; instead extract nothing: detect in callback `error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` (also match `err.message.includes('maxBuffer')` for older shapes). Simplest honest test: call `execFile`-backed `runScan` against a tiny fixture script? The integration test dir already runs real knip; add a focused unit test that stubs `execFile`? Not injectable. Pragmatic: export `MAX_SCAN_BUFFER_BYTES` and a pure `classifyExecError(error, stderr)` helper, unit-test the helper.

**Interfaces (Produces):** `KnipError.code` union gains `'report-too-large'`; message: `` `knip's JSON report exceeded ${MB} MB — narrow the scan (--workspace) or scan a smaller project` ``.

Steps:
- [ ] Refactor callback error branching into exported pure `classifyExecError` (returns `KnipError | null`), add maxBuffer branch first.
- [ ] Unit tests for the helper (AbortError, maxBuffer code, numeric exit ≥2, non-numeric, null).
- [ ] Commit `fix: surface knip maxBuffer overflow as a distinct report-too-large error (#3)`.

### Task A4: Pin Origin check to exact origin (#4)

**Files:**
- Modify: `src/server/index.ts` `/api/*` middleware
- Test: `tests/unit/server.test.ts` (extend)

Approach: a same-origin request's `Origin` (when present) is exactly `http://<Host header>`. Replace the loopback-regex with: if `origin` present, require `origin === 'http://' + host` (case-insensitive host compare; the server never serves https). Keep the no-Origin pass-through (same-origin GETs/POSTs from older browsers and in-process tests omit it).

Steps:
- [ ] Implement exact-match check (parse host from `c.req.header('host')`; missing Host + present Origin → still compare against nothing → reject).
- [ ] Tests: same-port origin passes; different loopback port (`http://127.0.0.1:9999`) now 403; `http://localhost:<port>` with Host `localhost:<port>` passes; non-loopback origin still 403 (already covered).
- [ ] Commit `fix: pin the /api Origin check to the exact request origin (#4)`.

### Task A5: Refuse to edit malformed configs (#5)

**Files:**
- Modify: `src/ignore/config-writer.ts` (`addIgnores`, `removeIgnores`)
- Test: `tests/unit/config-edits.test.ts` (extend)

Approach: jsonc-parser's `parse` recovers silently; collect `ParseError[]` (`parse(content, errors, {allowTrailingComma: kind==='knip.jsonc'})`) once per call, before any edit. On errors: `{ok: false, reason: 'config has a JSON syntax error at line N, column M — fix it before editing'}` (compute line/col from the first error's offset). knip.jsonc must still accept comments (`parse` handles comments natively; only flag real `ParseErrorCode`s, and for .json kind treat comments as errors? knip.json is parsed by knip itself with jsonc semantics — do NOT start rejecting comments in knip.json; only reject genuinely broken syntax: `InvalidSymbol`, `ValueExpected`, `ColonExpected`, `CloseBraceExpected`, `CloseBracketExpected`, `CommaExpected`, `InvalidEOF`, `PropertyNameExpected`).

Steps:
- [ ] Add shared `assertParsable(content): {ok: true} | {ok: false; reason}` used by both functions (replaces the current `root === undefined` check's role; keep that check too as belt-and-braces).
- [ ] Tests: truncated JSON (`{"ignore": [`) → refused with line/col; valid-with-comments knip.jsonc still edits; trailing-comma tolerated in jsonc kinds.
- [ ] Commit `fix: refuse config edits when knip.json/package.json is already malformed (#5)`.

---

## Batch B — review-flow client (issues #6, #7, #9 + client half of #2)

### Task B1: Restore pre-review open file on Cancel/Done (#6)

**Files:**
- Modify: `client/src/state/ui.ts` — `ReviewRequest` gains `returnOpenFile?: string`; `startReview` captures `state.openFile` into it (set-time capture keeps SelectionDock untouched).
- Modify: `client/src/components/pages/ReviewPage.tsx` — `handleLeave` passes `{openFile: review.returnOpenFile}` when `returnTo === 'code'` and the file wasn't deleted by an applied fix (check applied-ok delete: skip restore when `flow.status === 'applied'` and `review.returnOpenFile` is in `okPaths` and was a delete — pragmatic check: skip when `okPaths.includes(returnOpenFile)` and `filesToDelete(planIssuesRef.current, …)` contained it; if simpler, skip restore whenever the file appears in `deletePaths ∩ okPaths`).
- Test: `tests/client/ui-store.test.ts` (startReview captures openFile) + a small pure test for the restore-decision helper (extract `shouldRestoreFile(...)` into `client/src/lib/review.ts`).

### Task B2: Log applied files at mutation time, not component mount (#7)

**Files:**
- Modify: `client/src/components/pages/ReviewPage.tsx` — move the activity `log(...)` out of the `useEffect` into `handleApply`'s post-`mutateAsync` continuation (survives unmount); delete `loggedRef` + effect. Compute `okPaths`/summary from the mutation result inline via the same `joinResults`/`appliedOkIssueIds`/`summaryByType` helpers (they're pure — callable outside render).
- Test: `tests/client/apply-flow.test.ts` or new `tests/client/review.test.ts` case — pure-function level: given a mutation result, the computed log entry matches what the old effect produced (paths = ok rows only, no entry when all rows failed).

### Task B3: All-stale selection empty state + Rescan (#9)

**Files:**
- Modify: `client/src/components/pages/ReviewPage.tsx` — when `flow.status === 'idle'` and `selectedIssues.length === 0` (live selection empty under a frozen `review.frozenCount > 0`), render a dedicated empty state instead of the options step: "All N selected issues are stale — the code changed since the scan. Rescan and reselect." + `Rescan` button (`useScanMutation`, scope `reportQuery.data?.report?.scope`, then `handleLeave()`) + Cancel. Also disable "Preview changes" in that state (guard in `handlePreview`).
- Test: pure helper `isAllStale(flowStatus, selectedCount, frozenCount)` in `client/src/lib/review.ts` with unit tests.

### Task B4: Release cancelled plans (client half of #2)

**Files:**
- Modify: `client/src/api.ts` — `deleteFixPlan(planId): Promise<{deleted: boolean}>` calling `DELETE /api/fix/plan/${planId}`.
- Modify: `client/src/components/pages/ReviewPage.tsx` — in `handleLeave`, when `flow.status === 'previewed'` (plan compiled, never applied), fire-and-forget `deleteFixPlan(flow.planId)` (catch + ignore errors). Also on `reset` (Back from preview to options) — the old plan is dead weight.
- Test: `tests/client/api.test.ts` (extend, mirrors existing fetch-mock style).

Commits: `fix: restore the pre-review open file on Review exit (#6)`, `fix: record apply activity in the mutation continuation (#7)`, `feat: explicit all-stale empty state on the Review page (#9)`, `fix: release cancelled preview plans server-side (#2, client)`.

---

## Batch C — misc client (issues #8, #10, #11, #12)

### Task C1: Keep CommitDialog mounted through a tree-cleaning commit (#8)

**Files:**
- Modify: `client/src/components/app-shell/GitFooter.tsx` — move `<CommitDialog …/>` OUT of the `gitStatus.dirty && (…)` guard (render it unconditionally next to the button block, still gated on `gitStatus?.isRepo` if desired — Dialog renders nothing when `open` is false). The dialog already owns a success state with an explicit Done.
- Test: e2e already covers commit flow (`tests/e2e/commit-affordance.spec.ts`) — extend if cheap; otherwise browser-verify.

### Task C2: Whole-file banner in the too-large state (#10)

**Files:**
- Modify: `client/src/components/code/CodePane.tsx` — in the 413 branch, render `wholeFileIssues.map(WholeFileBanner)` (and the amber "too large" note below). Hoist `const wholeFileIssues = issues.filter(i => i.line === undefined)` above the early-return block so both paths share it.
- Test: none unit-testable cheaply (component); browser/e2e verify. `tests/e2e/codepane-crash.spec.ts` exists — extend if the fixture can host a >2MB file cheaply (generate one in the fixture script? skip if awkward — manual browser check instead).

### Task C3: Re-measure gutter overlay on resize (#11)

**Files:**
- Modify: `client/src/components/code/CodePane.tsx` (`CodeBlock`) — add a `ResizeObserver` on `containerRef` that bumps a `measureTick` state; include `measureTick` in the measuring `useLayoutEffect`'s deps. Guard: only re-measure, never re-run the scroll/pulse (the `scrolledKeyRef` guard already ensures that).
- Test: browser verify (resize window, badges stay aligned).

### Task C4: Production badge amber + tooltip (#12)

**Files:**
- Modify: `client/src/components/app-shell/GitFooter.tsx` — wrap the badge in the existing `Tooltip` primitives: "Scanned with --production — only production entry points traversed." Style amber via className (`border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400` — match the badge component's size classes; check `badge.tsx` variants first and add an `amber` variant only if a variant is the cleaner fit).
- Test: `tests/e2e/production-mode.spec.ts` exists — extend assertion if cheap; browser verify.

Commits: `fix: keep CommitDialog mounted when a commit cleans the tree (#8)`, `fix: show the whole-file banner for >2MB files (#10)`, `fix: re-measure gutter overlay on resize (#11)`, `feat: amber production badge with explanatory tooltip (#12)`.

---

## Final verification (orchestrator)

- [ ] `npm test`, `npm run typecheck`, `npm run build`.
- [ ] Browser pass against a fixture project: #6 (open file → review → cancel → file still open), #8 (commit all → dialog shows sha + Done), #9 (needs staged stale state — verify empty-state renders via forced empty selection), #10 (>2MB unused file → banner), #12 (badge amber + tooltip, needs `--production` server).
- [ ] Playwright e2e suite: `npm run test:e2e`.
- [ ] Close #1–#12 with per-issue comments; file any new issues discovered.
