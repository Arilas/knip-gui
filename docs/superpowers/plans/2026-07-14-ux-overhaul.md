# knip-gui UX Overhaul (v0.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the client UX per the approved spec: shadcn shell (icon-collapsible inset sidebar, warm purple theme), Dashboard / Code / Packages / Ignored / Activity pages, filter-aware selection, resizable code pane, centered dialogs, searchable workspace switcher, and a guided setup screen for scan failures.

**Architecture:** Server and engines stay put (one new `/api/ignores` endpoint + `removeIgnores` writer). The client keeps its data layer (`api.ts`, `queries.ts`, `apply-flow.ts`, `highlighter.ts`, `tree.ts` logic) and swaps the presentation layer for shadcn/ui components installed via CLI. A small zustand `ui` store carries page + per-page filters + navigation payloads (no router lib).

**Tech Stack (new):** shadcn/ui CLI components (`client/src/components/ui/`), lucide-react, sonner, react-resizable-panels (via shadcn Resizable), cmdk (via shadcn Command/Combobox).

**Spec:** `docs/superpowers/specs/2026-07-14-ux-overhaul-design.md`

## Global Constraints

- shadcn components come from `npx shadcn@latest add <component>` — NEVER hand-written imitations. Config in `client/components.json`.
- Theme: violet primary over warm stone neutrals (both modes) via CSS variables in `client/src/index.css`. Shiki themes switch to `vitesse-light`/`vitesse-dark`.
- **Every UI task ends with a live browser verification** on a throwaway fixture copy (`.tmp-tests/`, never `tests/fixtures/single`) using the Browser pane tools; the task report must state what was clicked and seen, and servers must be killed after.
- Selection rule: checking a file/folder adds ONLY issues of currently-enabled type filters; changing filters later never removes cart items; the selection bar reports true cart contents.
- Security posture unchanged: token header on every API call, no external resources in the bundle (verify lucide/shadcn don't pull CDN fonts).
- Suite must stay green per task: `npm run typecheck && npm test`; e2e specs broken by a task's UI changes are updated IN that task; full `npm run test:e2e` green required from Task 6 onward (intermediate tasks: at minimum the specs they touched).
- Node >= 20, strict TS, conventional commits, TDD for all pure logic.

## File Structure (end state)

```
client/src/
  components/ui/*                    (shadcn CLI output)
  components/app-shell/{AppSidebar,WorkspaceSwitcher,GitFooter}.tsx
  components/pages/{Dashboard,CodePage,PackagesPage,IgnoredPage,ActivityPage,SetupScreen}.tsx
  components/code/{TreeView,TreeNode,CodePane,FilterChips}.tsx   (moved/rebuilt)
  components/flows/{ActionModal,CommitPanel,DiffView,SweepDialog}.tsx (rebuilt on shadcn Dialog)
  state/{queries,selection,ui,activity}.ts
  lib/{tree,filters,apply-flow,highlighter,dashboard}.ts          (facets.ts → filters.ts)
src/server/routes-ignores.ts          (GET /api/ignores)
src/ignore/config-writer.ts           (+ removeIgnores)
```

---

### Task 1: shadcn foundation + app shell (sidebar, workspace switcher, theme)

**Files:**
- Create: `client/components.json` (shadcn init), `client/src/components/ui/*` (add: sidebar, button, badge, tooltip, dialog, alert-dialog, dropdown-menu, command, popover, input, table, sheet, separator, scroll-area, sonner, resizable, checkbox, tabs), `client/src/components/app-shell/{AppSidebar,WorkspaceSwitcher,GitFooter}.tsx`, `client/src/state/ui.ts`
- Modify: `client/src/index.css` (theme tokens), `client/src/App.tsx` (shell + page switch), `client/src/lib/highlighter.ts` (vitesse themes), `client/vite.config.ts` (shadcn alias `@/` if init requires)
- Delete: `client/src/components/TopBar.tsx`, `client/src/components/FacetRail.tsx`
- Test: `tests/client/ui-store.test.ts`

**Interfaces:**
- Consumes: `useReport`, `useGitStatus`, `postScan` from `client/src/state/queries.ts`.
- Produces:
  - `state/ui.ts` (zustand): `type Page = 'dashboard' | 'code' | 'packages' | 'ignored' | 'activity'`; `interface UiState { page: Page; codeFilters: Set<IssueType>; packagesFilters: Set<IssueType>; openFile?: string; navigate(page: Page, opts?: { filters?: IssueType[]; openFile?: string }): void; toggleCodeFilter(t: IssueType): void; togglePackagesFilter(t: IssueType): void }` — `navigate` with `filters` REPLACES that page's filter set; without, keeps current. Defaults: all file-located types on for code (`exports, types, enumMembers, namespaceMembers, files, duplicates, unresolved, unlisted`), all dep types on for packages (`dependencies, devDependencies, optionalPeerDependencies, binaries`).
  - `AppSidebar` (shadcn Sidebar, `variant="inset" collapsible="icon"`): nav items Dashboard/Code/Packages/Ignored/Activity with lucide icons (LayoutDashboard, FileCode2, Package, EyeOff, History) + count badges (`Ignored`/`Activity` badge-less); active state from ui store; `SidebarHeader` hosts WorkspaceSwitcher, `SidebarFooter` hosts GitFooter (branch, dirty dot w/ tooltip listing dirtyFiles count, scan timestamp, Re-run button disabled while busy).
  - `WorkspaceSwitcher`: shadcn Popover+Command combobox; entries = "All workspaces" (pinned) + report.workspaces sorted alphabetically, each with right-aligned issue count; search input filters; selecting calls `postScan(workspace)` (existing scoped-scan semantics); shows current scope; disabled while busy; collapses to an icon button in rail mode.
- Theme tokens (index.css, shadcn CSS-variable format, Tailwind v4 `@theme inline`): light: `--background` warm stone (e.g. `oklch(0.985 0.004 85)`), `--foreground` stone-900, `--primary` violet (`oklch(0.541 0.198 293)` ≈ violet-600), `--accent` warm stone tint; dark: stone-950 background (`oklch(0.147 0.007 60)`), violet-400 primary. Sidebar variables per shadcn sidebar docs. Exact values may be tuned during browser check — record final values in the report.

- [ ] **Step 1: shadcn init + add components** — `cd client && npx shadcn@latest init` (style: default, base color: stone, CSS variables: yes; if init demands path alias, add `"@/*": ["./src/*"]` to client/tsconfig.json + `resolve.alias` in vite.config.ts), then `npx shadcn@latest add sidebar button badge tooltip dialog alert-dialog dropdown-menu command popover input table sheet separator scroll-area sonner resizable checkbox tabs`. Verify `npm run build` still passes and no external URLs entered the bundle (`grep -o 'https://[^"]*' dist/client/assets/*.js | grep -v react.dev | grep -v w3.org` → empty or license comments only).
- [ ] **Step 2: TDD ui store** — tests: navigate replaces filters only when given; toggle flips; defaults correct; openFile set/cleared on navigate.
- [ ] **Step 3: Theme + shell + switcher + footer** — apply theme tokens; build AppSidebar/WorkspaceSwitcher/GitFooter; App.tsx renders shell + page placeholder stubs (`<Dashboard/>` etc. as "coming in task N" divs for pages not yet built, EXCEPT keep existing Code-page internals (TreeView/CodePane/SelectionBar) mounted under the `code` page so the app stays usable); delete TopBar/FacetRail; swap highlighter themes to vitesse + update its unit test.
- [ ] **Step 4: Update broken e2e selectors** — smoke/ignore/codepane specs reference the old facet rail for navigation (`facet-*` testids): update to sidebar nav testids (`nav-code`, `nav-packages`, …). Run `npm run typecheck && npm test && npm run test:e2e` → all green.
- [ ] **Step 5: Browser verification (mandatory)** — build, boot on a fixture copy, verify in Browser pane: sidebar renders with icons+badges, collapses to icon rail and back, workspace combobox opens/searches/shows counts, theme is warm purple in BOTH light and dark (resize_window colorScheme), Re-run works, no console errors. Screenshot evidence noted in report.
- [ ] **Step 6: Commit** — `feat(client): shadcn shell, warm purple theme, icon sidebar, workspace switcher`

---

### Task 2: Dashboard page

**Files:**
- Create: `client/src/components/pages/Dashboard.tsx`, `client/src/lib/dashboard.ts`, `client/src/components/flows/SweepDialog.tsx` (moved out of Overview)
- Delete: `client/src/components/Overview.tsx`
- Test: `tests/client/dashboard.test.ts`

**Interfaces:**
- Consumes: `useReport`, `ui.navigate`, sweep mutation from queries.ts, existing sweep-capabilities query.
- Produces (`lib/dashboard.ts`, pure, tested):
  - `typeTotals(issues): { type: IssueType; count: number }[]` (non-zero only, desc).
  - `workspaceRows(issues): { workspace: string; counts: Partial<Record<IssueType, number>>; total: number }[]`.
  - `visibleColumns(rows): IssueType[]` (types with any non-zero, stable order).
  - `sortRows(rows, key: 'workspace' | IssueType | 'total', dir)`, `filterRows(rows, query)`.
- Dashboard UI: stat-tile grid (shadcn Card-less — simple divs are fine — label, count, lucide icon per type); tile click → `navigate('code' | 'packages', { filters: [type] })` (dep-shaped types go to packages, file-located to code). Workspace table: shadcn Table, sticky header, sort toggles on every column (default total desc), search Input, TanStack Virtual when rows > 50; cell click navigates scoped: sets workspace scope? NO — cell click calls `navigate` with the type filter AND sets a tree path-prefix search for that workspace (`<ws>/`) — cheap scoping without a rescan; the true workspace SCOPE switcher (rescan) stays in the sidebar. Row "open" affordance navigates to Code with search prefix. Header `⋯` DropdownMenu hosts "Fix everything with knip --fix" opening SweepDialog (existing behavior/capabilities logic, now shadcn AlertDialog, centered).
- [ ] TDD dashboard.ts (totals, rows, non-zero columns, sort stability, search) → implement page → update any e2e touching Overview → typecheck+test+affected e2e → **browser verification**: tiles show fixture counts, tile click lands on Code with only that chip active, table sorts/searches, sweep dialog is CENTERED, works, no console errors → commit `feat(client): dashboard with stat tiles and sortable workspace table`.

---

### Task 3: Code page — filters, filter-aware selection, rebuilt tree, resizable split

**Files:**
- Create: `client/src/components/pages/CodePage.tsx`, `client/src/components/code/FilterChips.tsx`, `client/src/lib/filters.ts` (from facets.ts)
- Modify: `client/src/state/selection.ts` (filter-aware add), `client/src/lib/tree.ts` (dir rollup count, auto-expand policy), `client/src/components/code/{TreeView,TreeNode,CodePane}.tsx` (moved + rebuilt), delete `client/src/lib/facets.ts` after migrating helpers
- Test: `tests/client/filters.test.ts`, extend `tests/client/{selection,tree}.test.ts`

**Interfaces:**
- Produces:
  - `lib/filters.ts`: `CODE_TYPES` / `PACKAGE_TYPES` const arrays (as in ui store defaults); `filterIssues(issues, enabled: Set<IssueType>, query: string): Issue[]`; `typeLabel(type): string` (human names, reused everywhere); `isFixable/isIgnorable` migrated from facets.ts.
  - `selection.ts`: `addFileFiltered(fileIssues: Issue[], enabled: Set<IssueType>)` — adds only enabled-type issues; `toggle(ids)` unchanged for single-issue checkboxes; cart NEVER pruned by filter changes (test pins this).
  - `tree.ts`: `DirNode.totalCount` (rolled-up); `autoExpandDepth(tree, visibleFileCount): 'all' | 'top'` (threshold 200 files); existing build/tri-state logic intact — tri-state counts only issues matching CURRENT enabled filters (signature: `nodeSelectionState(node, selectedIds, enabledTypes)`).
- CodePage layout: `ResizablePanelGroup direction="horizontal"` — left panel (tree + FilterChips toolbar + search), handle, right panel (CodePane); sizes persisted via `autoSaveId="knip-code-split"`; right panel collapsible (collapse button; `openFile` empty state invites selection). FilterChips: one chip per CODE_TYPE with live count (from current workspace-filtered issues), Badge-styled toggle, all-on default, tooltip with full label; chips reflect/write `ui.codeFilters`.
- Tree rebuild: compact rows (h-7), lucide `Folder`/`FolderOpen`/`FileCode2`/file-type icons, chevron only on dirs, ENTIRE row click toggles dir expansion (file row click opens file), checkbox stops propagation; dir rows show ONE muted count (Tooltip shows per-type breakdown); file rows keep small per-type badges; dir checkbox uses `addFileFiltered` semantics across descendants; expand/collapse-all buttons in toolbar; auto-expand per `autoExpandDepth`; aria-labels on every control (`aria-label="Select all issues in src/"` etc.).
- [ ] TDD filters.ts + selection extension + tree extensions (incl. "cart survives filter toggle" and "dir check adds only enabled types" and tri-state respects enabledTypes) → build page/components → update e2e selectors (tree testids preserved where possible: keep `tree-file-<path>`/`tree-issue-<type>-<symbol>` ids) + ADD e2e spec `tests/e2e/filters.spec.ts`: disable "Unused exports" chip → check `src/used.ts` file checkbox → selection bar shows only non-export issues (assert exact summary) → re-enable chip → cart unchanged; apply flow still works end-to-end after rebuild → typecheck+test+e2e (all specs) → **browser verification**: icons+density, row-click expand, single dir count + tooltip breakdown, resizable drag persists across reload, pane collapse, filter chips drive tree AND selection, both themes, no console errors → commit `feat(client): code page with filter chips, filter-aware selection, rebuilt tree, resizable split`.

---

### Task 4: Packages page

**Files:**
- Create: `client/src/components/pages/PackagesPage.tsx`
- Delete: `client/src/components/TableView.tsx`
- Test: extend `tests/client/filters.test.ts` (package grouping helper)

**Interfaces:**
- Consumes: `filterIssues`, `PACKAGE_TYPES`, `ui.packagesFilters`, selection store, `getFile`.
- Produces: `groupByWorkspace(issues): { workspace: string; issues: Issue[] }[]` in filters.ts (tested).
- UI: FilterChips (PACKAGE_TYPES variant) + search; one shadcn Table per workspace group (workspace heading + select-all checkbox), sortable symbol/type/file columns, per-row checkbox (disabled + tooltip reason when unactionable), row click opens shadcn Sheet: package name, issue type explanation, and the workspace `package.json` content (via existing `getFile` + shiki jsonc highlight) scrolled to the dependency line when present.
- [ ] TDD grouping → build page → update ignore e2e spec selectors (left-pad flow now lives here; keep flow assertions identical) → typecheck+test+e2e → **browser verification**: chips filter, select-all works, sheet opens with highlighted package.json, ignore flow end-to-end on left-pad, both themes → commit `feat(client): packages page with grouped tables and detail sheet`.

---

### Task 5: Ignored + Activity pages (server: /api/ignores, removeIgnores)

**Files:**
- Create: `src/server/routes-ignores.ts`, `client/src/components/pages/{IgnoredPage,ActivityPage}.tsx`, `client/src/state/activity.ts`
- Modify: `src/ignore/config-writer.ts` (+ `listIgnores`, `removeIgnores`), `src/server/index.ts` (mount route), `client/src/api.ts` (+ getIgnores, postIgnoreRemove preview/apply reuse), `client/src/state/queries.ts`, ActionModal-adjacent wiring for the remove flow (reuse existing preview/apply dialog)
- Test: `tests/unit/ignores-endpoint.test.ts`, extend `tests/unit/config-edits.test.ts`, `tests/client/activity.test.ts`

**Interfaces:**
- `config-writer.ts`:
  - `listIgnores(projectDir): Promise<{ entries: IgnoreEntry[]; configKind: string; configPath?: string }>` where `IgnoreEntry = { kind: 'ignore' | 'ignoreDependencies' | 'ignoreBinaries'; value: string; workspace?: string }` — parses the SAME config discovery as findKnipConfig; 'code'/'none' kinds → empty entries + kind reported.
  - `removeIgnores(content, configKind, entries: IgnoreEntry[]): TransformResult` — jsonc-parser edits removing exact values from the right arrays (workspace-scoped included); value-not-found → per-call `{ok:false, reason:'not-found'}`; removing the last array element removes the key.
- `routes-ignores.ts`: `GET /api/ignores` → listIgnores result; `POST /api/ignores/remove/preview` `{ entries }` → FixPlan-shaped `{ planId, diffs, items }` via a small compiler that wraps removeIgnores into a FilePatch (reuse PlanStore + renderDiff); `POST /api/ignores/remove/apply` `{ planId }` → applyPatches + background rescan (same latch pattern as routes-fix).
- `state/activity.ts` (zustand, tested): `log(entry: { kind: 'fix' | 'ignore' | 'sweep' | 'commit' | 'ignore-remove'; summary: string; sha?: string; at: string })`, `entries` newest-first, capped at 200; ActionModal/CommitPanel/SweepDialog/remove flow call `log(...)` on success (timestamps via `new Date().toISOString()` at call time).
- IgnoredPage: entries grouped by kind with workspace column, per-entry Remove button → standard preview/apply dialog (diff of the config file) → applied → activity logged + rescan; header note: "@public-tagged exports aren't listed yet". Empty/code-config/none states explicit.
- ActivityPage: simple list (icon per kind, summary, relative time, sha mono when present) + "session only — clears on restart" note.
- [ ] TDD listIgnores/removeIgnores (fixture knip.json w/ root+workspace entries; jsonc comments preserved; last-element key removal) + endpoint tests (token-gated, plan single-use) + activity store tests → build pages + wire logging into the three existing success paths → typecheck+test+e2e → **browser verification**: ignore something on Packages, see it appear on Ignored, Remove it (diff shown, centered), rescan → issue returns in Code; Activity shows all of the above with timestamps; both themes → commit `feat: ignored page with config-backed removal and session activity log`.

---

### Task 6: Setup screen, shadcn dialogs everywhere, sonner

**Files:**
- Create: `client/src/components/pages/SetupScreen.tsx`
- Modify: `client/src/components/flows/{ActionModal,CommitPanel,DiffView}.tsx` (rebuild markup on Dialog primitives; move from components/ root), `client/src/components/Toast.tsx` → delete, replace with sonner `<Toaster/>` + `toast.error/success`, `client/src/App.tsx` (setup-state routing), `src/cli.ts` (friendlier stderr hint on scan failure)
- Test: `tests/client/apply-flow.test.ts` untouched (logic unchanged — verify), `tests/e2e/setup.spec.ts` NEW

**Interfaces & behaviors:**
- SetupScreen replaces ALL pages when `report.status === 'error'` and `error.code` is `knip-not-found` or `knip-failed` with `exitCode >= 2` (the store already carries these): shows heading ("knip couldn't scan this project"), the stderr verbatim in a copyable `<pre>` (copy button), a likely-causes list (no knip installed / no knip config found / config invalid — pick bullets by error code), a starter `knip.json` snippet with copy button, link `https://knip.dev/overview/configuration`, and Re-run. Sidebar stays visible (Activity still reachable).
- ActionModal/CommitPanel/SweepDialog on shadcn Dialog/AlertDialog: centered by construction; Escape + backdrop close disabled while `applying` (Radix `onInteractOutside`/`onEscapeKeyDown` preventDefault); all step logic/state machine untouched. DiffView unchanged except container classes.
- CLI: on initial-scan failure path, print `knip exited with <code> — open the UI for details and setup help` instead of nothing.
- `tests/e2e/setup.spec.ts`: fixture copy WITHOUT knip.json (delete it in setup) → boot → assert setup screen shows stderr block + starter snippet; then write knip.json into the fixture via fs, click Re-run, assert dashboard appears. Also extend smoke.spec.ts with a modal-centering assertion (dialog boundingBox roughly viewport-centered horizontally, top > 40px).
- [ ] Rebuild dialogs → sonner swap → SetupScreen + App routing + CLI hint → new e2e + centering assertion → full gates (`typecheck`, `test`, `test:e2e` ALL green from here on) → **browser verification**: break the fixture copy's knip.json (rename), see setup screen, fix it, Re-run recovers; run a fix flow and confirm dialog centered, Escape blocked while applying, toasts appear; both themes → commit `feat(client): setup screen, shadcn dialogs, sonner toasts`.

---

### Task 7: Polish, full e2e sweep, dogfood, docs

**Files:**
- Modify: `README.md` (screenshots section optional, updated feature list), `docs/backlog.md` (strike delivered items), any small fixes from dogfood
- Test: full suites

- [ ] Full-suite pass: `npm run typecheck && npm test && npm run test:e2e` all green; `npm pack --dry-run` clean (no components.json leakage outside dist, bundle size sanity — note gzip total).
- [ ] Bundle audit: no external URLs (fonts/CDN) in dist/client assets; dark/light both correct; icon rail collapse persists (SidebarProvider cookie/localStorage per shadcn default — verify and note).
- [ ] **Dogfood (mandatory):** run the built CLI against the knip-gui repo ITSELF (`node dist/cli.js --dir . --no-open`) in the Browser pane: walk Dashboard → Code (filters, selection, code pane) → Packages → Ignored → Activity; fix at least one real issue knip reports on this repo (there will be some — e.g. knip flags dead exports) via the full flow on a THROWAWAY branch (`git checkout -b dogfood-tmp`, apply + commit through the UI, then `git checkout main && git branch -D dogfood-tmp` after verifying); note every papercut found in `docs/backlog.md` (fix trivial ones inline).
- [ ] Update README (pages list, theme, screenshots placeholder) + backlog strikes; commit `docs: v0.2 ux overhaul notes`; final commit.
