# Backlog (v0.2 candidates)

Deferred findings from the v0.1 review cycles — none block usage; all were
explicitly triaged as non-blocking by the final whole-branch reviews.

## UX

- Code pane shows cached pre-apply content when an apply touches the open file —
  invalidate the file query on rescan (`client/src/state/queries.ts`).
- Modal title reads "Ignore 0 issues" on the results step (recomputes from live
  selection after pruning) — freeze the count at plan time (`ActionModal.tsx`).
- Empty source lines render 0-height spans, hiding their line numbers (`index.css`).
- Pluralization: "1 exports" / "1 files" in summaries and badges (`selection.ts`).
- Tree expand/collapse state resets when passing through a table facet — lift
  expansion state to App.
- Overview quick actions from the spec ("fix all unused deps in <ws>" pre-filling
  the cart) — plan-approved narrowing, revisit.
- Table row-click preview (package.json context / unresolved import site) —
  plan-approved narrowing, revisit.
- CodePane 413 branch skips the whole-file "unused" banner for >2MB files.
- Gutter overlay doesn't re-measure on window resize (benign today: lines never wrap).
- TableView type column always shown (only needed on the merged dependencies facet).

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
