# Backlog (v0.2 candidates)

Deferred findings from the v0.1 review cycles — none block usage; all were
explicitly triaged as non-blocking by the final whole-branch reviews. Task 7
(final polish/dogfood pass) re-checked every item below against the current
code; status notes are inline where something changed.

## Delivered in Task 7 (polish + dogfood)

- Sidebar collapse state didn't survive a reload: shadcn's stock
  `SidebarProvider` (`client/src/components/ui/sidebar.tsx`) writes the
  `sidebar_state` cookie on every toggle but never reads it back — that
  pattern assumes a Next.js server component reads the cookie during SSR and
  passes it down as `defaultOpen`. This app has no SSR, so the cookie was
  write-only and a reload always reverted to expanded. Fixed: seeds initial
  state from the cookie via a lazy `useState` initializer (applied before
  first paint). Verified live in the Browser pane: toggle collapsed ->
  reload -> stays collapsed; toggle expanded -> reload -> stays expanded.
- `useSweepMutation` invalidated the report query `onSuccess` only, the same
  bug Task 6 fixed for `useScanMutation` — a failed sweep left the UI showing
  stale cached data with no sign anything went wrong. Fixed to `onSettled`,
  pinned with a unit test in `tests/client/queries-invalidation.test.ts`.
- Added `knip.json` (entry: `src/index.ts`, `src/cli.ts`,
  `client/src/main.tsx`, `scripts/*.ts`; ignore: `tests/fixtures/**`, which
  are intentionally-dead-code fixtures for this repo's own tests) so the
  built CLI can dogfood this repo instead of drowning in fixture noise.
- `package.json` gained `main`/`types` pointing at `dist/index.js(.d.ts)` —
  `src/index.ts` is the package's programmatic export surface
  (`createServer`, `runScan`, `normalize`, etc.) but was never wired into
  `package.json`, so nothing could actually `import` it; this also fixed a
  knip false-positive where `index.ts` read as a fully dead file once
  `knip.json`'s explicit `entry` list replaced knip's default auto-entry
  heuristics that had silently been covering it.
- Added `.idea/` to `.gitignore`.
- Dropped the no-op `test.describe.configure({ mode: 'serial' })` in
  `tests/e2e/dashboard.spec.ts` (single test in the file; it did nothing).

## Dogfood findings (Task 7 — built CLI run against this repo's own code)

- `client/src/components/ui/scroll-area.tsx` and `tabs.tsx` are
  genuinely-dead vendored shadcn primitives (zero imports anywhere).
  Confirmed via the new `knip.json` and live-fixed via the app's own Fix
  (delete-file) flow on a throwaway branch (`dogfood-tmp`) specifically to
  verify the apply-through-commit round trip; the branch was discarded per
  the dogfood protocol once verified, so both files are still present here.
  Trivial follow-up: delete them for real in a small cleanup PR.
- **Real gap found live:** once a Fix is applied, the `ActionModal`'s inline
  Commit step is the *only* place in the UI that can commit it. Dismissing
  the modal first (Close / Escape / backdrop click) instead of clicking
  Commit leaves the fix applied-but-uncommitted with no warning, and there is
  no other in-app affordance to commit it later — the user must trigger
  another fix/ignore/sweep flow (whose own Commit step only stages *that*
  flow's just-fixed paths — confirmed live, it correctly warned "Your working
  tree also has 1 other uncommitted change(s)") or fall back to git directly.
  Follow-up: either a persistent "commit N uncommitted files" action in
  `GitFooter`, or block modal dismissal until Skip/Commit is chosen
  explicitly (Skip already exists as the intentional escape hatch; the gap is
  that Close/Escape/backdrop behave like an unlabeled Skip with no way back).
- Observed once, not root-caused: after that early modal dismissal, the app
  appeared stuck in a disabled/busy state for 10+ seconds — a direct `curl`
  to `/api/report` showed `status:"ready"` with the fresh post-fix report
  well before the UI reflected it; only a full page reload recovered. May be
  related to dismissing the modal mid-flow rather than a universal bug on
  every apply. Flagged for follow-up investigation.
- Packages page correctly flags `lsof` (invoked via `execFile` in
  `scripts/e2e-fixture.ts` for a port-liveness check) as an "unused binary" —
  a legitimate knip false positive for system utilities that aren't npm
  dependencies; not fixable through the app (binaries have no fix mode) and
  not worth a permanent ignore entry for one occurrence. Noted for awareness.
- Activity page's own copy ("Session only — clears on restart") is slightly
  imprecise — the log is a client-only zustand store
  (`client/src/state/activity.ts`), so it clears on any full page
  reload/navigation, not only a server restart. Low-priority copy fix.
- Commit-message pluralization: the Fix flow's default commit message read
  "chore(knip): remove 1 files" for a single file — the same gap as the
  "Pluralization" item below, now also confirmed live in the generated
  message template (`client/src/components/flows/CommitPanel.tsx`). Rolled
  into that existing item rather than listed twice.
- Filter-chip counts (Task 3 review carryover): confirmed live that an OFF
  chip shows the count it *would* reveal, scoped only by search, not by which
  chips are enabled (`client/src/components/code/FilterChips.tsx`,
  `TreeView.tsx`). **Decision: leave as-is.** The chip's own fill-vs-outline
  styling already signals on/off state, the count's meaning ("how many this
  would reveal") is intuitive without further UI, and the `aria-label`
  already appends " (hidden)" for screen readers.
- Walked every page (Dashboard, Code incl. filters/selection/code pane,
  Packages, Ignored, Activity) against this repo's own real ~60-issue
  report, dark and light themes, sidebar expanded and collapsed — no console
  errors, no broken pages.

## UX

- Code pane shows cached pre-apply content when an apply touches the open file —
  invalidate the file query on rescan (`client/src/state/queries.ts`). Still open.
- Modal title reads "Ignore 0 issues" on the results step (recomputes from live
  selection after pruning) — freeze the count at plan time (`ActionModal.tsx`).
  Still open.
- Empty source lines render 0-height spans, hiding their line numbers (`index.css`).
  Still open.
- Pluralization: "1 exports" / "1 files" in summaries and badges (`selection.ts`),
  and in the Fix flow's generated commit message (`CommitPanel.tsx`). Still open.
- Tree expand/collapse state resets when passing through a table facet — lift
  expansion state to App. The original "table facet" toggle is gone (Code/Packages
  are now separate pages) but the root cause reproduces via page navigation
  instead (`TreeView.tsx`'s expansion state is still local, not lifted). Still open.
- Overview quick actions from the spec ("fix all unused deps in <ws>" pre-filling
  the cart) — plan-approved narrowing, revisit.
- Table row-click preview (package.json context / unresolved import site) —
  plan-approved narrowing, revisit.
- CodePane 413 branch skips the whole-file "unused" banner for >2MB files.
  Still open.
- Gutter overlay doesn't re-measure on window resize (benign today: lines never wrap).
  Still open.
- ~~TableView type column always shown (only needed on the merged dependencies
  facet).~~ Resolved by restructure: the old `TableView` shim is gone; Packages
  is now per-workspace tables (`PackagesPage.tsx`) that always mix multiple
  package-issue types, so there's no longer a narrower facet to gate the column on.

## Engine / server

- Coerce string-form `ignore` knip config to array instead of rejecting
  (`src/ignore/config-writer.ts`).
- Defensive parse-error check before editing pre-malformed JSON configs.
- PlanStore size cap / TTL for never-applied plans.
- Sweep endpoint server-side latch (client serializes today).
- Tighten Origin check to the server's exact origin (port) now that the SPA origin
  is fixed.
- `close()` doesn't reap an in-flight knip child process.
- `--port abc` prints a raw stack instead of a friendly message.
- maxBuffer overflow indistinguishable from knip crash in error code.
- Monorepo workspace-scoped ignore lacks a real-knip e2e (unit-verified against
  knip source).
- Ordinal issue-id drift when an earlier same-key duplicate disappears (documented
  tradeoff in `normalize.ts`).

## Parked product ideas (from the spec)

Trash-instead-of-delete · PR creation via `gh` · watch mode · git-blame age of dead
code · export-usage heatmap · per-issue fix-mode overrides in the modal.
