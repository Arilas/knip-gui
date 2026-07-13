# knip-gui UX overhaul (v0.2) — Design

**Date:** 2026-07-14
**Status:** Approved for planning
**Supersedes:** the UX section of `2026-07-13-knip-gui-design.md` (engines, API, and
security posture unchanged)

## Motivation (real-project findings, 2026-07-13 dogfood on a 200-workspace monorepo)

- Overview matrix put workspaces in COLUMNS → unusable at scale.
- Code pane rendered on every page, not resizable, wasted a third of the screen.
- Tree: no icons, badge soup on dir rows, 10px expand hit-target, no density.
- Facet pages forced navigation where filtering was wanted; selection ignored filters.
- Modals pinned top-left (Tailwind preflight strips native `<dialog>` auto-margins).
- Native workspace `<select>` unusable at 200 entries.
- Scan failure showed raw "knip exited with 7" with no guidance.
- A11y: facet buttons had no accessible names.

## Decisions

- **Component system:** shadcn/ui, installed via `npx shadcn@latest` CLI into
  `client/src/components/ui/` — never hand-written copies. Existing Tailwind v4 +
  React 19 stack.
- **Theme:** warm purple — violet primary, warm stone neutral scale, both modes.
  Shiki switches github-light/dark → `vitesse-light`/`vitesse-dark` (warm-toned).
- **IA:** shadcn inset sidebar, collapsible to icon rail. Items: Dashboard, Code,
  Packages, Ignored, Activity (lucide icons + count badges). Sidebar top: workspace
  switcher (searchable Combobox, sorted by name, issue counts shown, "All
  workspaces" pinned; switching re-scans scoped — semantics unchanged). Sidebar
  footer: git branch + dirty dot, scan timestamp, Re-run. TopBar and FacetRail die.

## Pages

### Dashboard
- Stat tiles: project totals per issue type; click → Code/Packages pre-filtered.
- Workspace table: workspaces as ROWS. Sortable (default total desc), search box,
  only non-zero issue-type columns rendered, virtualized beyond ~50 rows. Each cell
  links to Code/Packages scoped to that workspace + type filter.
- Header "…" menu holds the `knip --fix` sweep action (confirm dialog unchanged).
- No code pane on this page.

### Code (tree + code pane)
- shadcn Resizable split, drag handle, collapsible pane, layout in localStorage.
- Filter toolbar replaces facet pages: multi-select type chips with live counts for
  file-located types (exports, types, enumMembers, namespaceMembers, files,
  duplicates, unresolved, unlisted), all-on by default, plus path/symbol search.
- **Filter-aware selection:** checking a file/folder adds ONLY issues of enabled
  types. Changing filters later never removes cart items (cart is a stable basket);
  the selection bar always shows true cart contents by type.
- Tree: compact rows; lucide folder/file icons; chevron on folders, whole row
  toggles expansion; ONE rolled-up count per dir row (tooltip shows the per-type
  breakdown); per-type badges only on file rows. Auto-expand all when ≤200 visible
  files, else top level; expand-all/collapse-all buttons. Every control gets an
  aria-label.

### Packages
- Dep-shaped issues (dependencies, devDependencies, optionalPeerDependencies,
  binaries): shadcn Table, sortable headers, grouped by workspace, type-filter
  chips, select-all respecting disabled rows. Row click opens a Sheet with
  package.json context via existing `/api/file`.

### Ignored
- New endpoint `GET /api/ignores`: server parses knip config (root + per-workspace
  `ignore`, `ignoreDependencies`, `ignoreBinaries`) → entries with source
  (file + workspace + kind). Page lists them grouped by kind; per-entry Remove goes
  through a new `removeIgnores` config-writer function via the existing
  preview/apply patch pipeline (diff shown in the standard dialog).
- `@public`-tagged exports are NOT listed in v1 (needs repo-wide scan); the page
  says so.

### Activity
- Client-side session log (zustand store): applies, ignores, sweeps, commits —
  summary, sha where applicable, timestamp. Cleared on restart; page states this.

## Modals, errors, setup

- ActionModal / CommitPanel / sweep confirm rebuilt on shadcn Dialog/AlertDialog
  (fixes centering by construction). All flow logic (`apply-flow.ts`,
  preview==apply, result joins, commit message reconciliation) unchanged.
- Toasts → shadcn sonner.
- **Setup screen** (full-page state, not a route): scan error with exit ≥ 2 or
  `knip-not-found` → shows knip's stderr (copyable), likely causes, a starter
  `knip.json` snippet, docs link, Re-run. CLI stderr hint improved to match.

## What survives / dies

- **Unchanged:** server + engines (one new endpoint + `removeIgnores`), `api.ts`,
  `queries.ts`, `apply-flow.ts`, `highlighter.ts` (theme swap only), security
  posture, e2e harness.
- **Extended:** `selection.ts` (filter-aware add), `tree.ts` (rolled-up dir counts,
  icon metadata, auto-expand policy), `facets.ts` → repurposed as filter/type
  grouping helpers.
- **Deleted:** TopBar, FacetRail, Overview, hand-rolled modal/table/toast shells.

## Testing

- Vitest (pure logic): filter-aware selection rules, dir count rollups, auto-expand
  policy, workspace-table sort/search model, ignores parsing.
- E2E updated to new selectors + new specs: filter-aware file selection (disable a
  type, check file, assert cart contents), workspace combobox search→scoped scan,
  dashboard cell → filtered Code navigation, setup screen on a config-less fixture,
  resizable pane persistence, modal centering assertion.
- Live dogfood pass on a real monorepo before merge (manual, documented).

## Out of scope (unchanged from v0.1 backlog)

Everything in `docs/backlog.md` not explicitly listed above; `@public` ignore
enumeration; server-side sweep latch (client still serializes).
