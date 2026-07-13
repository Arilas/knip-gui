# knip-gui Plan 3: Frontend SPA + E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web UI: facet rail + tree/table views + shiki code pane + selection cart + fix/ignore modal with diff preview + sweep + commit panel, served by the existing CLI, proven by a Playwright e2e smoke.

**Architecture:** Vite React SPA in `client/`, built to `dist/client`, served statically by the Hono server with the session token injected into `index.html` at serve time. Client state: TanStack Query for server data, one zustand store for the selection cart. All views are projections of `Report.issues`.

**Tech Stack (new):** react, react-dom, @tanstack/react-query, @tanstack/react-virtual, zustand, shiki (lazy langs, dual github-light/github-dark themes), tailwindcss v4 (@tailwindcss/vite), @vitejs/plugin-react, @playwright/test (chromium only).

**Spec:** `docs/superpowers/specs/2026-07-13-knip-gui-design.md` (see Errata).

## Carried-over obligations from Plan 2's final review (binding)

- `Report` gains `scope?: string` (workspace the scan was limited to; absent = full project) — and every rescan (post-apply background, post-sweep awaited) re-uses the LAST scan's scope instead of silently widening to full-project.
- Sweep endpoint isn't self-latched: the UI must disable the sweep control while any scan/sweep/apply is in flight (client-side serialization).
- Apply's `failedItems` are compile-time only: the client joins apply `results` (per file) with the previewed diffs it already holds to render per-file outcomes.
- `nsExports`/`nsTypes`/`unlisted`/`unresolved`/`binaries`/`catalog`/`cycles` are not fixable, and only deps/files/binaries/export-ish types are ignorable — unfixable+unignorable issues render read-only with a reason tooltip.

## Global Constraints

- Token comes ONLY from the `<meta name="knip-gui-token">` tag; every fetch sends `x-knip-gui-token`. No token in URLs.
- The SPA must work at `http://127.0.0.1:<port>/` with no external network access (no CDN fonts/scripts; bundle everything).
- Dark/light via `prefers-color-scheme` (shiki dual themes + Tailwind `dark:` variants).
- `npm run build` produces a publishable package: `dist/` (server + cli) AND `dist/client/`; `files: ["dist"]` already covers it. `npx knip-gui` must serve the real UI after build.
- Keep the existing 237 server tests green; client logic tests run in the same vitest run (jsdom project) — keep heavy rendering tests OUT (Playwright covers real rendering).
- Node >= 20, ESM, strict TS everywhere including client/. Conventional commits, TDD where the subject is logic (stores, selectors, api client); visual components are covered by the e2e, not unit snapshots.

---

### Task 1: Report scope field + client scaffold + static serving

**Files:**
- Modify: `src/core/types.ts` (Report.scope), `src/server/index.ts` + `src/server/routes-fix.ts` (record + reuse scan scope, serve static client, inject token), `src/cli.ts` (no change expected — verify), `package.json` (scripts, deps), `tsconfig.json` (exclude client), `.gitignore` (dist stays ignored)
- Create: `client/index.html`, `client/vite.config.ts`, `client/tsconfig.json`, `client/src/main.tsx`, `client/src/App.tsx` (placeholder "knip-gui" heading), `client/src/index.css` (tailwind entry)
- Test: extend `tests/unit/server.test.ts` (scope recorded + reused; token injected into built index.html when dist/client exists; fallback shell when not built), `tests/unit/` scope test

**Interfaces:**
- Produces: `Report.scope?: string`; server stores `lastScanScope` and `performRescan`/scan route pass it through; `GET /` serves `dist/client/index.html` with `<meta name="knip-gui-token" content="__KNIP_GUI_TOKEN__">` placeholder replaced by the real token (build emits the placeholder; serve-time string replace), assets under `/assets/*` served statically WITHOUT token (they're public js/css; the API stays tokened); fallback to the Plan 1 inline shell when `dist/client` is absent.
- npm scripts: `build` = server tsc + `vite build` (root script `build:client`), `dev:client` = vite dev with proxy to a running server (document token handling for dev: vite proxy + VITE_KNIP_TOKEN env for dev only).

Steps: scaffold configs (vite root `client/`, outDir `../dist/client`, emptyOutDir), write failing server tests for scope + token injection + fallback, implement, `npm run build` and verify `node dist/cli.js --dir tests/fixtures/single --no-open` serves the built placeholder App. Commit.

---

### Task 2: API client, stores, App shell (top bar + facet rail + overview)

**Files:**
- Create: `client/src/api.ts`, `client/src/state/selection.ts`, `client/src/state/queries.ts`, `client/src/components/{TopBar,FacetRail,Overview}.tsx`, `client/src/lib/facets.ts`
- Test: `tests/client/facets.test.ts`, `tests/client/selection.test.ts`, `tests/client/api.test.ts` (vitest, node/jsdom env, mock fetch)

**Interfaces:**
- `api.ts`: token from meta tag; typed fns `getReport()`, `postScan(workspace?)`, `getFile(path)`, `postFixPreview(sel)`, `postFixApply(planId)`, `postIgnorePreview(ids)`, `postIgnoreApply(planId)`, `postSweep(opts)`, `getSweepCapabilities()`, `getGitStatus()`, `postGitBranch(name)`, `postGitCommit(message, paths)`. Non-2xx → throws `ApiError{status, body}`. Import Issue/Report types from `../../src/core/types.js` (type-only; verify vite/tsc handle the cross-root import — else duplicate types in `client/src/types.ts` with a comment pointing at the source of truth; document choice).
- `facets.ts` (pure, unit-tested): `FACETS` const — `overview | tree | files | exports | types | enumMembers | namespaceMembers | duplicates | dependencies | unlisted | unresolved | binaries` with labels; `facetCounts(issues, workspace)`, `issuesForFacet(facet, issues, workspace)` (tree facet = all file-bearing types; dependencies facet = the 3 dep types; each table facet = its type), `isFixable/isIgnorable(issue)` with reason strings.
- `selection.ts` (zustand, unit-tested): `Set<issueId>` + `modeOverrides`; actions `toggle(ids[])`, `clear()`, `setMode(id, mode)`; selectors `count`, `summaryByType(issues)` ("12 exports, 3 files").
- `queries.ts`: react-query hooks `useReport` (poll every 2s while status==='scanning'), `useGitStatus`, mutations wrapping api fns; a `busy` derived flag (any scan/sweep/apply mutation in flight) consumed by TopBar re-run + sweep controls (serialization obligation).
- Shell: `TopBar` (project name from report, workspace `<select>` (workspaces list, '.'→"All workspaces"; changing it calls postScan(workspace)), Re-run button (disabled while busy), scan timestamp, git branch + dirty dot); `FacetRail` (facet list w/ count badges, active facet state in App); `Overview` (cards per issue type × workspace grid with counts, a "Fix everything with knip --fix" sweep button — confirm dialog listing fixTypes checkboxes + allow-remove-files toggle, disabled while busy, calls postSweep).

Steps: TDD the three pure/store modules; build shell components; wire App with QueryClientProvider; visual check via `npm run build` + CLI serve against the single fixture (screenshot not required; e2e covers). Commit per module.

---

### Task 3: Tree + table views with selection

**Files:**
- Create: `client/src/components/{TreeView,TreeNode,TableView,SelectionBar}.tsx`, `client/src/lib/tree.ts`
- Test: `tests/client/tree.test.ts` (pure tree building/rollup/tri-state logic)

**Interfaces:**
- `tree.ts` (pure, unit-tested): `buildTree(issues): DirNode` — nested dir/file nodes, each carrying `issueIds`, `counts` (rollup by type), `fileIssues` per file node; `nodeSelectionState(node, selectedIds): 'none'|'some'|'all'` (only fixable/ignorable-relevant ids count); `collectIds(node)`.
- `TreeView`: virtualized flat-rendered expansion (TanStack Virtual over visible rows), expand/collapse, tri-state checkboxes (dir → toggles all beneath), file rows show per-type badges + expandable issue rows (symbol, line, mode-relevant badge); clicking a file row selects it for the CodePane (Task 4 prop callback `onOpenFile(path)`); filter input (substring on path/symbol); "only issues" is inherent (tree built from issues only) — label it.
- `TableView` (for dependencies/unlisted/unresolved/binaries facets): sortable columns (symbol, filePath, workspace), header select-all checkbox, per-row checkbox; unfixable rows' checkboxes disabled with reason tooltip.
- `SelectionBar` (sticky bottom): summary from selection store + `Ignore`/`Fix…`/`Clear` buttons (disabled when 0 or busy); fires `onOpenModal('fix'|'ignore')`.

Steps: TDD tree.ts (nested build, rollups, tri-state incl. unfixable exclusion, collect), then components, wire into App with facet switching (tree facet shows all file-bearing issues; per-type facets filter). Manual serve check. Commit.

---

### Task 4: Shiki code pane

**Files:**
- Create: `client/src/components/CodePane.tsx`, `client/src/lib/highlighter.ts`
- Test: `tests/client/highlighter.test.ts` (pure: language pick, issue-line mapping)

**Interfaces:**
- `highlighter.ts`: lazy singleton `createHighlighter` with themes `github-light`/`github-dark` and langs loaded on demand by extension (`ts`,`tsx`,`js`,`jsx`,`json`,`jsonc`); `langForPath(path)` pure + tested; `highlightToHtml(content, path)` returns dual-theme HTML (`defaultColor: false` CSS-variable strategy per shiki docs — verify against installed shiki README and note API found); `issueLines(issues, path)`: map line→issues for gutter markers.
- `CodePane`: fetches file via `useQuery(getFile)`, renders shiki HTML with line numbers; lines carrying issues get a gutter marker + inline badge (type + symbol) + checkbox toggling that issue in the cart; issue rows for the file WITHOUT line info (e.g. whole-file) render as a header banner (unused file → "this whole file is unused" + checkbox). Empty state when no file selected; loading + too-large (413) + error states.

Steps: TDD the pure helpers, implement pane, wire `onOpenFile` from TreeView, manual serve check on fixture (verify highlight + markers + dark mode). Commit.

---

### Task 5: Fix/ignore modal, apply flow, commit panel

**Files:**
- Create: `client/src/components/{ActionModal,DiffView,CommitPanel,Toast}.tsx`, `client/src/lib/apply-flow.ts`
- Test: `tests/client/apply-flow.test.ts` (pure state machine)

**Interfaces:**
- `apply-flow.ts` (pure, unit-tested): state machine `idle → previewing → previewed → applying → applied(results)` with `failed(error)`; `joinResults(previewDiffs, applyResults, planItems)` → per-file rows {filePath, status: ok|stale|missing|io-error|compile-failed, reason} (the client-side join obligation); `defaultCommitMessage(summary)` → `chore(knip): remove 12 unused exports, 3 files` style from selection summary; `commitPaths(previewDiffs)` = changed file list.
- `ActionModal` (fix or ignore): step 1 options — for fix: per-type mode radio (strip-export default vs delete-declaration) applied as modeOverrides to all selected export/type issues (per-issue override deferred, YAGNI), file-deletion confirm list; for ignore: explanation of what will be written (config file path from first preview or generic). Step 2 diff preview: per-file collapsible shiki-highlighted diffs (lang 'diff'), items with ok:false listed with reasons. Step 3 apply: per-file result rows via joinResults; then `rescanning…` indicator tied to report query polling; on fresh report, cart prunes ids no longer present (selection store action `pruneMissing(ids)`).
- `CommitPanel` (post-apply step inside the modal, shown when gitStatus.isRepo): dirty-tree warning (non-blocking), optional "create branch first" toggle w/ prefilled `chore/knip-cleanup-2026-07-13` (today), message textarea prefilled via defaultCommitMessage, commit button → postGitCommit(message, paths from applied ok files); success shows sha; errors show stderr.
- `Toast`: minimal error/success toasts for api failures (ApiError surfaced with body.error/stderr).

Steps: TDD apply-flow.ts, build modal + diff view + commit panel, wire SelectionBar buttons, full manual loop on a THROWAWAY COPY of the fixture (never mutate tests/fixtures/single in the repo — copy to .tmp-tests, git init, run CLI against it, exercise fix + commit in the browser manually via `npm run build && node dist/cli.js --dir .tmp-tests/<copy>`). Commit.

---

### Task 6: Playwright e2e + packaging polish

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/smoke.spec.ts`, `scripts/e2e-fixture.ts` (copy fixture → .tmp-tests, git init, print dir)
- Modify: `package.json` (script `test:e2e`), `README.md` (dev docs: build, e2e), `.github/` NOT in scope (no CI setup)

**Interfaces:**
- `playwright.config.ts`: chromium only, `webServer` launches `node dist/cli.js --dir <fixture-copy> --no-open --port 4818` (globalSetup runs e2e-fixture + `npm run build` if dist missing), baseURL `http://127.0.0.1:4818`.
- `smoke.spec.ts` flow: page loads (title `knip-gui`) → report ready (overview shows counts) → switch to tree facet → expand to `src/used.ts` → check `unusedHelper` issue checkbox + check `orphan.ts` file checkbox → selection bar shows "2" → Fix… → modal shows 2 diffs → Apply → results all ok → wait for rescan → tree no longer lists `unusedHelper`/`orphan.ts` → commit panel: prefilled message → Commit → sha rendered. One additional spec: dependencies facet table select `left-pad` → Ignore → preview shows knip.json diff → apply → rescan → gone.
- Packaging: `npm pack --dry-run` sanity — dist/client present, no fixtures/tests; verify `bin` works from the packed tarball in a temp dir against the fixture copy (script or manual, documented in report).

Steps: config + fixture script, write both specs, `npx playwright install chromium` (document size), run e2e green, packaging check, README dev section, commit.
