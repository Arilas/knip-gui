# knip-gui v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the apply modal with a Review page, redesign the selection bar, add code-pane auto-scroll, test-file hints, `--production` mode, the sidebar commit affordance, and the accumulated papercut/e2e/hardening bundles.

**Architecture:** Presentation-layer rework on the v0.2 shadcn shell. `apply-flow.ts` state machine, preview/apply endpoints, and security posture unchanged. New page `review` in the ui store; ActionModal/CommitPanel die.

**Spec:** `docs/superpowers/specs/2026-07-14-v03-review-page-design.md`

## Global Constraints

- Same discipline as the v0.2 plan: shadcn components only (no hand-rolled shells), warm purple theme tokens, every UI task ends with live Browser-pane verification on a throwaway fixture copy (report what was clicked/seen; kill servers; clean up), suite green per task (`typecheck` + `npm test` + affected e2e; full e2e from Task 5 on), conventional commits, TDD for pure logic.
- Selection rule, token security, preview==apply guarantees all unchanged.
- Keep data-testids stable where specs rely on them; new surfaces get testids (`review-*`, `selbar-*`, `commit-affordance-*`).

---

### Task 1: Engine hardening + `--production` mode (server + CLI)

**Files:**
- Modify: `src/ignore/config-writer.ts` (string-form `ignore` coercion in addIgnores), `src/server/routes-fix.ts` (sweep synchronous latch), `src/cli.ts` (`--production` flag, `--port` validation, reap knip child on close), `src/core/knip-runner.ts` (runScan opts `{ workspace?, production? }` → `--production` arg; expose child handle or an abort for reaping), `src/server/index.ts` + `src/server/store.ts` (thread production through scan/rescan like `scope`; `Report.production: boolean`), `src/core/types.ts`
- Test: extend `tests/unit/{config-edits,server,server-fix}.test.ts`, `tests/integration/{knip-runner,cli}.test.ts`

**Interfaces produced:** `runScan(dir, { workspace?, production? })`; `createServer({ projectDir, scan?, production? })` — production fixed at server start (CLI flag), applied to every scan incl. rescans; `Report.production`; sweep route returns 409 when a sweep OR scan is in flight (latch synchronous before first await); `startCli` opts gain `production?: boolean`; invalid `--port` prints `invalid --port: <value>` and exits 1 without a stack.
- [ ] TDD each: coercion (string→array preserving value), sweep double-POST → one 409 (stalling sweep fn), production flag threading (fake scan fn records args; report.production true; rescan after apply keeps it), port validation (spawn CLI with --port abc → stderr message, exit 1), child reap (close() during a stalled scan kills the child — integration test with a slow fake knip bin). Commit.

---

### Task 2: Selection bar + review-flow state (client foundations)

**Files:**
- Create: `client/src/components/SelectionDock.tsx`, `client/src/lib/review.ts`
- Modify: `client/src/state/ui.ts` (page 'review'; `review?: { kind: 'fix' | 'ignore'; planId?: string; summary: string; frozenCount: number; returnTo: Page }` state + `startReview/clearReview`; tree expansion state lifted here: `expandedDirs: Set<string>` + actions), `client/src/lib/filters.ts` or new `client/src/lib/pluralize.ts` (`pluralizeType(count, type)` — "1 export" / "2 exports" / "1 file"...), `client/src/state/selection.ts` (summary uses pluralize), `client/src/components/code/TreeView.tsx` (expansion from ui store), delete `client/src/components/SelectionBar.tsx`
- Test: `tests/client/review.test.ts`, `tests/client/pluralize.test.ts`, extend ui-store/selection tests

**Interfaces produced:** `SelectionDock` (docked flex sibling, never overlay; testids `selbar-count`, `selbar-items-popover`, `selbar-fix`, `selbar-ignore`, `selbar-clear`; per-item remove in popover); `review.ts`: `buildFileRail(diffs, items, results?)` → rail rows {filePath, status: pending|ok|stale|missing|io-error|compile-failed, reason?}; pluralize helper used by dock, badges, commit messages. Expansion-lift: expanding dirs on Code, navigating to Packages and back keeps expansion (test).
- [ ] TDD pure modules → build dock → wire into CodePage/PackagesPage layout (docked, pushes content) → update e2e selectors (filters.spec asserts summary text — now pluralized!) → browser-verify (dock styling both themes, popover remove, docked-not-floating) → commit.

---

### Task 3: Review page (modal dies)

**Files:**
- Create: `client/src/components/pages/ReviewPage.tsx`, `client/src/components/review/{FileRail,ReviewHeader,CommitBar}.tsx`
- Modify: `client/src/App.tsx` (route 'review', redirect w/o pending review), `client/src/components/flows/DiffView.tsx` (reused as the main diff area), delete `client/src/components/flows/ActionModal.tsx` + `CommitPanel.tsx`, activity logging call sites move to ReviewPage/CommitBar
- Test: extend `tests/client/apply-flow.test.ts` only if signatures move (they shouldn't); `tests/e2e/review.spec.ts` NEW (replaces smoke.spec's modal steps — rewrite smoke.spec accordingly)

**Interfaces:** SelectionDock's Fix/Ignore now: compile preview via existing mutations → `startReview({kind, planId, summary: pluralized, frozenCount, returnTo})` → navigate('review'). ReviewPage: header (frozen summary; fix-mode radios BEFORE preview compile — note: mode changes require re-preview: header exposes modes only in the pre-preview step... simplify: SelectionDock's Fix opens Review page in an 'options' step (modes + delete confirm) with the file list showing affected files from the SELECTION (client-side), Apply-gating button "Preview changes" compiles the plan → 'preview' step with diffs; then Apply → 'applied'. Cancel any time → returnTo. This keeps one page with 3 steps and no modal); FileRail virtualized >100; CommitBar mirrors old CommitPanel behavior (branch toggle, reconciled pluralized message, sha inline, dirty warning). Escape does NOT dismiss; the page persists until Cancel/commit/skip. All old testids for e2e replaced by `review-*` ones; update smoke/filters/codepane-crash specs.
- [ ] Build → rewrite affected e2e (smoke flow via Review page; new review.spec.ts covering: multi-file fix with rail statuses, stale-file path (edit between preview/apply → rail shows stale, commit excludes), cancel-and-return, ignore flow) → full gates → browser-verify (walk fix+ignore end-to-end on fixture copy, big-selection feel, both themes, keyboard: tab through rail, Escape doesn't nuke) → commit.

---

### Task 4: Code pane auto-scroll + test-file hint + code-pane cache invalidation

**Files:**
- Modify: `client/src/components/code/CodePane.tsx` (scroll-to-first-issue + pulse; empty-line line-number fix from backlog; banner hint), `client/src/components/code/TreeNode.tsx` (flask icon on likely-test unused-file rows), `client/src/lib/filters.ts` (+ `isLikelyTestFile(path)`), `client/src/state/queries.ts` (invalidate file query on report refresh after apply), `client/src/index.css` (pulse animation, empty-line fix)
- Test: `tests/client/filters.test.ts` (isLikelyTestFile table: positives incl. `src/__tests__/x.ts`, `a/e2e/y.spec.tsx`, `Button.stories.tsx`; negatives incl. `src/test-utils.ts` (no), `contest.ts`, `src/latest/file.ts`), queries invalidation test

**Behaviors:** on openFile change, after highlight render, scroll first issue line to center + 1.2s pulse ring; re-open same file re-scrolls. Flask (lucide FlaskConical) + tooltip + docs link on tree rows AND banner for unused-file issues where isLikelyTestFile. File query invalidated when a fresh report arrives post-apply (open file shows @public tag/stripped export without reopening — pin with the codepane-crash spec extended or a small e2e assertion).
- [ ] TDD helpers → implement → browser-verify (open long fixture file — add a taller file to the fixture copy if needed at runtime, not committed; watch auto-scroll + pulse; flask tooltip; apply ignore on open file → pane refreshes) → gates → commit.

---

### Task 5: Commit affordance + Activity copy + remaining papercuts

**Files:**
- Create: `client/src/components/flows/CommitDialog.tsx`
- Modify: `client/src/components/app-shell/GitFooter.tsx` ("N uncommitted" button when dirty), `client/src/state/activity.ts` (+ `appliedPaths(): Set<string>` selector over session entries), `client/src/components/pages/ActivityPage.tsx` (copy), any remaining hand-rolled buttons in flows → shadcn Button sweep
- Test: `tests/client/commit-dialog.test.ts` (pure checklist-defaulting: dirty files ∩ appliedPaths pre-checked; others unchecked), e2e `tests/e2e/commit-affordance.spec.ts` (apply a fix via Review page, SKIP the commit bar, navigate away, use footer affordance → dialog shows the applied file pre-checked → commit → sha; assert an unrelated dirty file created via fs stays unchecked and uncommitted)

- [ ] TDD checklist logic → build dialog + footer wiring (activity log entry on success) → e2e → gates → browser-verify (both themes, keyboard) → commit.

---

### Task 6: E2E additions + final polish + dogfood

**Files:**
- Create: `tests/e2e/workspace-switcher.spec.ts` (combobox search → scoped scan on monorepo-shaped synthetic report or real monorepo fixture copy — real fixture preferred: boot against a copy of tests/fixtures/monorepo), `tests/e2e/resizable.spec.ts` (drag handle, reload, assert persisted sizes)
- Modify: `README.md` + `docs/backlog.md` (strike delivered, add findings), version bump 0.3.0

- [ ] New specs green + FULL gates (`typecheck`, `npm test`, `test:e2e` all specs, `npm pack --dry-run`) → dogfood on this repo (walk everything incl. Review page on a real multi-file fix, production-mode boot `node dist/cli.js --dir . --production` shows the badge, commit affordance) on a throwaway branch per established protocol → docs updates → commit.
