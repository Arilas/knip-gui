# knip-gui v0.3 — Review page, selection bar, scan modes, hardening — Design

**Date:** 2026-07-14
**Status:** Approved for planning
**Supersedes:** the ActionModal/CommitPanel/SelectionBar portions of
`2026-07-14-ux-overhaul-design.md`. Everything else from v0.2 stands.

## Motivation (mint.ai dogfood, 2026-07-14)

- Big files: no auto-scroll to the first issue in the code pane.
- Selection drawer still hand-rolled (wrong colors) and floats over content.
- Apply modal becomes a giant scrollable wall on large selections.
- Tests flagged as unused files (knip plugin/entry detection — config, not a bug)
  confused a real user; the product should hint.
- Plus v0.2 backlog: post-apply commit gap, papercuts, missing e2e, engine hardening.

## 1. Review page (replaces ActionModal)

- Entry: selection bar `Fix…` / `Ignore…` → compile preview (existing endpoints)
  → navigate to page `review` (NOT a sidebar nav item; only reachable with a
  pending review; direct nav without one → redirect to Code).
- Layout: sticky header — intent + frozen issue summary (count captured at plan
  time — kills the "Ignore 0 issues" bug), fix-mode radios (strip-export /
  delete-declaration) where applicable, file-deletion confirm checkbox, primary
  **Apply**, Cancel (back to previous page, discards the plan client-side; plans
  are single-use server-side already).
- Left rail: affected files with per-file status (pending → ok / stale / failed
  reasons after apply), compile-failed items listed with reasons; click selects
  the file shown in the main diff area. Virtualized beyond ~100 files.
- Main: ONE file's diff at a time (shiki 'diff', existing DiffView), scrollable
  within the pane. No page-level scroll walls.
- Apply: statuses update in the rail; a **commit bar** docks at the bottom of the
  page (dirty warning, branch toggle w/ `chore/knip-cleanup-<date>` prefill,
  reconciled + correctly pluralized message, Commit → sha inline). The page stays
  reachable until commit or explicit dismissal — combined with §6 there is no
  longer any way to strand an applied-but-uncommitted fix invisibly.
- `apply-flow.ts` state machine unchanged; this is presentation. ActionModal.tsx
  and CommitPanel.tsx are deleted (commit logic moves to the commit bar + §6
  dialog). SweepDialog and RemoveIgnoreDialog remain dialogs.
- Activity logging call sites preserved (fix/ignore/commit).

## 2. Selection bar

- Slim bar docked at the bottom of the content area (layout sibling, never
  overlays content), shadcn tokens/components only.
- Contents: total count, per-type Badges, popover ("N items ▾") listing each
  selected item (path + symbol + type) with per-item remove, Clear, `Fix…`,
  `Ignore…`.
- Visible on Code + Packages; hidden when empty.

## 3. Code pane auto-scroll

- On file open, scroll the first issue line into view (centered) with a brief
  highlight pulse; driven by the existing issueLines map. Files whose only issue
  is whole-file (banner) don't scroll. Re-opening the same file re-triggers.

## 4. Test-file heuristic

- Pure `isLikelyTestFile(path)`: `*.test.*`, `*.spec.*`, `__tests__/`,
  `__mocks__/`, `*.stories.*`, `e2e/`, `test/` or `tests/` path segments.
- Unused-file issues matching it show a flask icon + tooltip: "Looks like a test
  file — knip may be missing your test runner's config" linking to
  https://knip.dev/reference/plugins — in the tree row and the code-pane
  whole-file banner. Display-only; no config edits.

## 5. `--production` scan mode

- CLI flag `--production` → every scan (initial, re-run, post-apply rescan,
  sweep rescan) passes `--production` to knip.
- `Report.production: boolean`; server threads the mode through scan options the
  same way `scope` works.
- UI: amber "production" Badge next to the scan timestamp (sidebar footer),
  tooltip explaining knip's stricter production semantics. Marker only; no UI
  toggle in v0.3.

## 6. Commit affordance (sidebar footer)

- When `gitStatus.dirty`, footer shows an "N uncommitted" button → small Dialog:
  checklist of dirty files (files appearing in this session's activity applied
  paths pre-checked; others unchecked with a "not changed by knip-gui" hint),
  message textarea, commits ONLY checked paths via the existing endpoint.
  Success → sha toast + activity entry.

## 7. Ride-alongs

- **Papercuts:** pluralized labels everywhere incl. commit messages (shared
  `pluralizeType(count, type)` helper); code-pane file query invalidated after an
  apply touches the open file; Activity copy → "Session only — clears when the
  page reloads"; empty source lines keep visible line numbers; tree expansion
  state lifted into the ui store (survives page switches); any remaining
  hand-rolled buttons in flows → shadcn Button.
- **E2E additions:** workspace-combobox search → scoped scan; resizable-pane
  persistence across reload; Review page fix flow end-to-end (select → review →
  apply → commit bar → sha); commit-affordance dialog flow.
- **Engine hardening:** string-form `ignore` coerced to array on addIgnores;
  server-side sweep latch (mirror scan's synchronous latch); `--port` validation
  with friendly error; CLI close() reaps an in-flight knip child.

## Out of scope

Auto-editing knip config for test runners; UI toggle for production mode;
`@public` ignore enumeration; persistent activity log.

## Testing

Pure logic (isLikelyTestFile, pluralize, review-page rail model, commit-checklist
defaulting) via vitest; e2e per §7; every UI task browser-verified live per the
established discipline; final dogfood on this repo + verification against a
monorepo fixture with a test-file-shaped unused file.
