# Backlog

Deferred findings from review cycles across v0.1–v0.3 — none block usage; all
were explicitly triaged as non-blocking by the final whole-branch reviews.
Each polish/dogfood pass (most recently Task 6 of the v0.3 plan) re-checks
every item below against the current code; status notes are inline where
something changed, and resolved items are struck through rather than
deleted so the history stays legible.

## Delivered in the post-v0.3 research fix pass (2026-07-15)

A multi-agent audit + live dogfood pass, then a whole-branch fix (commit
`f2fe82b`). Verified: 563 unit/integration + 17 e2e pass, typecheck clean
(server/client/tests), production-only `npm pack` install boots and serves.

- **Correctness (transforms):** exported function overloads no longer break the
  build — strip-export/delete-declaration sweep the whole overload set instead
  of the first signature only (was TS2383); comment-adjacency transforms
  (`expandStartWithLeadingComments`, `insertPublicTag`, enum member removal) no
  longer eat/merge a neighbor's trailing/leading comment (shared own-line-start
  guard); workspace globs expand `**` / mid-pattern `*`, apply `!` exclusions,
  and read `pnpm-workspace.yaml` only under the `packages:` key (was
  mis-attributing every issue to root `package.json`); `Object.hasOwn` replaces
  `in`/prototype lookups; `findKnipConfig` precedence matches knip's real order.
- **Security:** loopback `Host`-header guard closes DNS-rebinding token theft;
  commit/add paths are `:(literal)`-prefixed so pathspec magic can't widen a
  scoped commit.
- **Server robustness:** malformed/null request bodies no longer clobber a ready
  store (shared `readJsonObject`); occupied `--port` exits with a friendly
  message; sweeps are abortable + reaped on shutdown; `app.onError` returns a
  JSON error envelope; the sweep-failure body is a string the client can show;
  `/api/git/status` has a try/catch; the duplicated scan pipeline is unified into
  `runScanIntoStore`.
- **Client races:** working-tree writes invalidate `['git-status']` (footer was
  stale until refocus); apply mutations moved to `onSettled`; the Review page is
  guarded against a concurrent rescan/workspace-switch; CommitBar branch creation
  is idempotent on retry + guards an empty branch name; switching workspaces
  warns before discarding a selection; the sweep dialog resets between opens and
  toasts on failure.
- **Publish readiness:** 17 client/build-only packages moved to
  `devDependencies` (runtime needs only 7 — verified via omit-dev install);
  `prepublishOnly` build; `IGNORABLE_ISSUE_TYPES` exported from core so
  client/server ignorability can't drift; `tsconfig.tests.json` typechecks
  tests/scripts.
- **UX / a11y:** real "Scanning…" state instead of a false "knip is happy"
  during the first scan; the sweep dialog's inverted-checkbox trap (all-unchecked
  = fix everything) fixed with explicit copy + a scope-stating button; whole-file
  banner uses readable type labels; theme tokens replace hardcoded
  gray/red/white; aria-labels + `aria-sort`; the `(s)` pluralization in CommitBar
  removed.
- **Tests:** throwaway-repo tests disable `commit.gpgsign` — was silently hanging
  the `e2e-loop` integration test on any machine that signs commits
  (GPG/1Password).

Still open after this pass (see also the sections below): tree arrow-key ARIA
navigation, browser-history/URL routing, the all-stale-apply dead-end message,
`/api/scan` not checking the sweeping latch, PlanStore cap/TTL, and the
`maxBuffer`-overflow error code — none re-verified as fixed here.

## Delivered in v0.3 (Task 6 final review + dogfood)

New e2e coverage: `tests/e2e/workspace-switcher.spec.ts` (real scoped rescan
against a monorepo-shaped fixture, asserts `report.scope` and the tree both
narrow), `tests/e2e/resizable.spec.ts` (drag-to-resize and pane-collapse both
persist across a reload), `tests/e2e/production-mode.spec.ts` (the new
sidebar badge below).

- **Sidebar "Production" badge** (new, this task): `Report.production` has
  existed since v0.3 Task 1's `--production` CLI flag, but nothing in the UI
  ever surfaced it — found while dogfooding this task's own mandatory
  `--production` boot, whose brief assumed a badge already existed. Added
  next to `GitFooter`'s "Scanned <time>" stamp. See the README's
  `--production` gotcha below for what else this dogfood run turned up.
- **Tree expansion seed-delta** (new, this task): a rescan that introduces a
  brand-new top-level directory used to render it collapsed by default (the
  one-time expansion seed had already fired and never re-runs) — carried over
  from the v0.3 Task 2 review as a "dogfood-check in T6" item. Implemented
  the cheap fix rather than just documenting it: `state/ui.ts`'s new
  `expandDirs` action additively merges paths a rescan introduces that
  weren't present at the last look, tracked off the raw (pre search/filter)
  issue list so toggling a chip or typing a search term can never be mistaken
  for a rescan (`components/code/TreeView.tsx`'s tree-change effect).
- **`--production` mode dependency false-positive** (dogfood finding, not
  fixable in knip-gui): booting this repo's own `node dist/cli.js --dir .
  --production` reports all 19 of `client/`'s runtime dependencies as
  unused, because knip's production mode doesn't traverse past
  `client/src/main.tsx` on this project's layout (confirmed via `knip
  --production --trace-file client/src/App.tsx` → "No exports found", vs. a
  full reachability trace in normal mode). knip-gui just threads
  `--production` straight through to real knip, so this isn't a knip-gui
  bug — documented prominently in the README as a gotcha for anyone running
  `--production` against a similarly-shaped (bundler-driven, non-workspace
  client subdirectory) project.
- Packages page's `lsof`-binary false positive (see the still-open note
  below) now shows **3** occurrences instead of 1 — the two new e2e specs
  above reuse the existing stray-server-reaping pattern (`lsof -ti :<port>`)
  from `scripts/e2e-fixture.ts`. Same non-issue, just more instances of it;
  still not worth a permanent ignore entry.
- Walked every page again (Dashboard, Code, Packages, Ignored, Activity)
  against this repo's own report in both `--production` and normal mode,
  both themes — ran a real multi-file fix (two files, one export + one type)
  through the Review page on a throwaway `dogfood-tmp` branch, committed
  through the Review page's own commit bar (verified sha `4d88941` via `git
  show --stat`), ran a second fix and deliberately Skipped its commit bar,
  then committed that one separately via the sidebar footer's "N uncommitted
  files" affordance (verified sha `ab9f1ca`) — both commit affordances (the
  Review page's and the footer's) exercised in the same session, Activity
  page logged all 4 entries correctly. No new papercuts found beyond the two
  items above; switched back to `feat/v03-review` and deleted `dogfood-tmp`
  per protocol.
- The "app appeared stuck in a disabled/busy state for 10+ seconds after an
  early modal dismissal" item from the old Task 7 dogfood findings (below) no
  longer applies to the current app: `ActionModal` (the component that bug
  was about) doesn't exist anymore — Task 3 of the v0.3 plan replaced it with
  the dedicated Review page, which doesn't have an equivalent "dismiss
  mid-flow" gesture (Escape is explicitly a no-op while Review is open, per
  its own e2e coverage). Marking as superseded rather than re-verifying a
  code path that's gone.

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

- ~~`client/src/components/ui/scroll-area.tsx` and `tabs.tsx` are
  genuinely-dead vendored shadcn primitives.~~ **Delivered**: both files are
  gone from the tree — the "small cleanup PR" this item asked for happened.
- ~~**Real gap found live:** once a Fix is applied, the `ActionModal`'s inline
  Commit step is the *only* place in the UI that can commit it.~~
  **Delivered** (v0.3 Task 3 replaced `ActionModal` with the Review page;
  v0.3 Task 5 added the persistent "N uncommitted files" `GitFooter` action
  this item's follow-up proposed) — both the Review page's docked commit bar
  and the sidebar footer's standing affordance now exist, and Task 6
  exercised both live in the same dogfood session (see above).
- ~~Observed once, not root-caused: after that early modal dismissal, the app
  appeared stuck in a disabled/busy state for 10+ seconds.~~ **Superseded**:
  the modal this was about no longer exists (see above) — not re-verified
  since there's no equivalent code path left to check.
- Packages page correctly flags `lsof` (invoked via `execFile` in
  `scripts/e2e-fixture.ts` for a port-liveness check) as an "unused binary" —
  a legitimate knip false positive for system utilities that aren't npm
  dependencies; not fixable through the app (binaries have no fix mode) and
  not worth a permanent ignore entry. Still open — now 3 occurrences (see
  Task 6 entry above).
- ~~Activity page's own copy ("Session only — clears on restart") is slightly
  imprecise.~~ **Delivered** (v0.3 Task 5): now reads "clears when the page
  reloads."
- ~~Commit-message pluralization: the Fix flow's default commit message read
  "chore(knip): remove 1 files" for a single file.~~ **Delivered** — see the
  "Pluralization" item below (same fix covers both).
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

- ~~Code pane shows cached pre-apply content when an apply touches the open
  file.~~ **Delivered** (v0.3 Task 4): every fix/ignore/sweep mutation
  invalidates the whole `['file']` query-key prefix on settle
  (`invalidateFileQueries` in `client/src/state/queries.ts`).
- ~~Modal title reads "Ignore 0 issues" on the results step (recomputes from
  live selection after pruning).~~ **Delivered**: `ActionModal` is gone; the
  Review page's `ReviewRequest.frozenCount`/`summary` (`client/src/state/ui.ts`)
  are frozen at `startReview` time specifically to fix this class of bug.
- ~~Empty source lines render 0-height spans, hiding their line numbers.~~
  **Delivered** (v0.3 Task 4): `min-height` on `.shiki code .line`
  (`client/src/index.css`) — confirmed live during Task 6 dogfood (opened a
  700-line real file with a blank line mid-scroll; its gutter number rendered
  correctly).
- ~~Pluralization: "1 exports" / "1 files" in summaries and badges, and in the
  Fix flow's generated commit message.~~ **Delivered** (v0.3 Task 2/5):
  `client/src/lib/pluralize.ts`, used by selection summaries and both
  `CommitBar`'s and `CommitDialog`'s generated messages — confirmed live
  during Task 6 dogfood ("chore(knip): commit 1 file", singular, not "1
  files").
- ~~Tree expand/collapse state resets when passing through a table facet.~~
  **Delivered** (v0.3 Task 2): `expandedDirs` lives in `state/ui.ts`, not
  local component state, and survives page navigation. Task 6 went further
  and fixed the seed-delta follow-up too (see above).
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

- ~~Coerce string-form `ignore` knip config to array instead of rejecting.~~
  **Delivered** (v0.3 Task 1): `src/ignore/config-writer.ts`'s addIgnores
  coerces an existing string-form `ignore` glob into the first array element
  before appending.
- Defensive parse-error check before editing pre-malformed JSON configs.
- PlanStore size cap / TTL for never-applied plans.
- ~~Sweep endpoint server-side latch (client serializes today).~~
  **Delivered** (v0.3 Task 1): `src/server/routes-fix.ts`'s `registerFixRoutes`
  now has a synchronous `sweeping` boolean latch (set before the route's
  first `await`, cleared in `finally`) mirroring `/api/scan`'s own
  check-then-latch pattern.
- Tighten Origin check to the server's exact origin (port) now that the SPA origin
  is fixed. **Partly addressed** (2026-07-15): a `Host`-header loopback guard now
  fronts every route, which is the stronger fix — it also covers the
  header-absent same-origin GET the Origin regex never saw (the DNS-rebinding
  path). Pinning the Origin regex to the exact port is still a possible follow-up.
- ~~`close()` doesn't reap an in-flight knip child process.~~ **Delivered**
  (v0.3 Task 1): `src/cli.ts`'s `close()` calls `store.abortActiveScan()`
  (which aborts the active scan's `AbortSignal`, killing its `execFile`
  child) before shutting the HTTP server down.
- ~~`--port abc` prints a raw stack instead of a friendly message.~~
  **Delivered** (v0.3 Task 1): `src/cli.ts` validates `--port` synchronously
  before calling `startCli` — prints `invalid --port: <value>` and exits 1,
  no stack trace.
- maxBuffer overflow indistinguishable from knip crash in error code.
- Monorepo workspace-scoped ignore lacks a real-knip e2e (unit-verified against
  knip source).
- Ordinal issue-id drift when an earlier same-key duplicate disappears (documented
  tradeoff in `normalize.ts`).

## Parked product ideas (from the spec)

Trash-instead-of-delete · PR creation via `gh` · watch mode · git-blame age of dead
code · export-usage heatmap · per-issue fix-mode overrides in the modal.

## v0.3 final-review findings (all minor, post-merge candidates)

- Cancel/Done from Review clears the previously-open Code file (`ui.ts` navigate
  always overwrites openFile) — restore it on return.
- Navigating away mid-applying skips the activity-log effect, so CommitDialog
  later shows those files as "not changed by knip-gui" (tiny window).
- CommitDialog unmounts abruptly (no Done state) when a commit cleans the whole
  tree — success toast still shows.
- `/api/scan` doesn't check the sweeping latch (scan can start during a sweep's
  child-process phase; client serializes via useBusy).
- Cancel-after-preview orphans the compiled plan server-side (feeds the existing
  PlanStore cap/TTL item).
- Seed-delta TreeView diff logic untested at component level; Production badge
  lacks tooltip and uses secondary variant (spec said amber).
