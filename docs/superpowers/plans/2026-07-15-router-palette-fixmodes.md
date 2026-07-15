# Router + Command Palette + Per-Issue Fix Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub issues #22 (per-issue fix-mode overrides — relabeled bug), #14 (TanStack Router with clean paths, URL = page + file + workspace), and #25 (⌘K command palette + bare keyboard shortcuts), in that order, one commit per issue (multiple commits allowed for #14).

**Architecture:** #22 is a pure Review-page UI change over existing state (`selection.ts` `modeOverrides` per issue id; `compileFixPlan` already accepts the map). #14 replaces `ui.ts`'s `page`/`openFile`/`navigate` with TanStack Router (code-based routes, browser history, root layout = app shell), keeps filters/search/selection/review-request in zustand, and adds a server SPA-fallback route. #25 builds on the router: a global CommandDialog (shadcn `ui/command.tsx` already vendored) + a `useGlobalShortcuts` hook.

**Tech Stack:** @tanstack/react-router (new dep, code-based routes — no Vite plugin), React 19, zustand, react-query, Hono (server fallback), vitest + Playwright.

**User decisions (2026-07-15):** clean paths + server catch-all (not hash); URL carries page + open file + workspace (boot rescan when URL ws differs from report scope); #22 relabeled bug + implemented now; #15 explicitly skipped.

## Global Constraints

- One commit per issue: `fix: … (#22)`, `feat: … (#14)` (may be split into `feat: server SPA fallback (#14)` + `feat: tanstack router pages (#14)`), `feat: … (#25)`. No auto-close keywords.
- `npm test` + `npm run typecheck` green after every task; `npm run test:e2e` green after R and P (e2e specs may need updating for the router — updating navigation setup is legitimate, weakening assertions is not).
- Comments: dense "why, not what". Match existing patterns (zustand vanilla stores stay unit-testable without React).
- The bearer-token model is untouched: the SPA shell (with token substituted) is what the fallback serves; /api/* keeps its 404/401 semantics.

---

### Task M: Per-issue fix-mode overrides on the Review options step (#22)

**Files:**
- Modify: `client/src/components/review/ReviewHeader.tsx` (options step)
- Modify: `client/src/components/pages/ReviewPage.tsx` (props wiring)
- Test: `tests/client/review.test.ts` (pure helper)

**Interfaces:**
- Consumes: `useSelectionStore` `modeOverrides: Record<string, FixMode>` + `setMode(id, mode)`; `Issue.fixModes` (exports/types have `['strip-export','delete-declaration']`); `filesToDelete` already reads per-issue overrides, so mixed modes flow into the delete-confirm list and `deletePaths` automatically; `compileFixPlan` already takes the map — zero server changes.
- Produces: pure helper `effectiveFixMode(issue: Issue, overrides: Record<string, FixMode>): FixMode` in `client/src/lib/review.ts` (override ?? `issue.fixModes[0]` ?? 'strip-export').

Steps:
- [ ] Failing unit tests for `effectiveFixMode` (override wins; falls back to fixModes[0]; default 'strip-export').
- [ ] Implement helper.
- [ ] ReviewHeader options step: keep the two global radios (they continue to write ALL selected export/type issues via the existing `onSetExportTypeMode` loop — the radio now reflects "checked" only when EVERY issue's effective mode matches, else neither is checked → render an "(mixed)" hint next to the legend). Below the radios, a per-issue list (max-h-40 overflow-y-auto): each row = `filePath: symbol` (mono, truncate) + a compact native `<select>` with that issue's `fixModes` options, value = `effectiveFixMode(issue, modeOverrides)`, onChange = `setMode(issue.id, mode)`. `data-testid="fix-mode-select-<issueId>"`. Only rendered for issues with >1 fixMode.
- [ ] ReviewPage: pass `modeOverrides` + `setModeOverride` down (it already has both); replace the single `currentExportTypeMode` prop with whatever minimal shape the header now needs (derive mixed-state inside the header from the map + issues, not in ReviewPage).
- [ ] `npm test` + typecheck; commit `fix: per-issue fix-mode overrides on the Review options step (#22)`.

Verification (orchestrator, browser): select 2+ export issues → Review → set one to delete-declaration, leave the other strip-export → preview shows the mixed diffs (one deletes the declaration, one only unexports) → radios show mixed state.

---

### Task R: TanStack Router — real pages, URL state, server fallback (#14)

**Files:**
- Modify: `package.json` (add `@tanstack/react-router`)
- Create: `client/src/router.tsx` (route tree + router instance)
- Modify: `client/src/main.tsx` (RouterProvider), `client/src/App.tsx` (shell becomes the root-route layout; page switch → `<Outlet/>`), `client/src/state/ui.ts` (drop `page`/`openFile`/`openFileNonce`(keep nonce, see below)/`navigate`; keep filters/search/review/expandedDirs), call sites: `AppSidebar.tsx`, `Dashboard.tsx`, `CodePage.tsx`, `ReviewPage.tsx`, `SelectionDock.tsx`, `WorkspaceSwitcher.tsx`, `GitFooter.tsx`
- Modify: `src/server/index.ts` (SPA fallback)
- Test: `tests/unit/server.test.ts` (fallback), `tests/client/ui-store.test.ts` (trim), new `tests/e2e/routing.spec.ts`; existing e2e specs updated where they assumed reload→Dashboard

**Route design (code-based, `createBrowserHistory`):**
- Root route: renders SidebarProvider + AppSidebar + header + `<Outlet/>` (the "layout"); global search param `ws` (workspace scope) validated/retained across navigations via `retainSearchParams(['ws'])` search middleware so every in-app navigation keeps the scope in the URL.
- Pathless layout route `_report` wrapping `/dashboard`, `/code`, `/packages`: its component renders the report gate (loading / error / SetupScreen / scanning states — the logic currently inline in `AppShell.renderPage()`) around an `<Outlet/>`.
- `/code` validates `file` search param (optional string).
- `/ignored`, `/activity`: plain routes.
- `/review`: `beforeLoad` (or component effect, whichever fits the zustand read) redirects to `/code` when `useUiStore.getState().review` is undefined — replaces App.tsx's guard effect.
- `/` → redirect to `/dashboard`. Router `defaultNotFoundComponent` → redirect `/dashboard`.

**State migration rules:**
- `ui.ts` keeps: `codeFilters`, `packagesFilters`, `codeSearch`, `review`, `expandedDirs*`, and `openFileNonce` (bumped by an explicit `bumpOpenFileNonce()` action — CodePage's tree-row click calls it so re-clicking the already-open file still re-fires CodePane's scroll/pulse; the router won't re-navigate on an identical URL).
- `ReviewRequest.returnTo: Page` → `returnTo: string` (a path); `startReview` no longer sets `page` (caller navigates to `/review` after calling it); `returnOpenFile` unchanged.
- `navigate(page, {filters})` call sites (Dashboard tiles/cells): filters/search set via the existing zustand setters (add a `setCodeFilters(types)`/`setPackagesFilters(types)` replace-style setter to ui.ts — the old navigate's replace semantics), THEN `router.navigate({to})`. Keep the "filters only apply to the target page" semantics.
- `reviewing` checks (`useUiStore((s) => s.page === 'review')` in GitFooter/WorkspaceSwitcher) → `useRouterState`/`useMatchRoute` for `/review`.
- Workspace: WorkspaceSwitcher's `runSwitch` additionally writes the `ws` search param (`navigate({search: (prev) => ({...prev, ws})})`, '.'/All = param removed). Boot hydration: one-shot effect in the root layout — if `ws` param present AND report ready AND `report.scope !== ws` AND not busy → fire `scanMutation.mutate(ws)` once (ref-guarded; document why: reload/bookmark restores scope, but mid-session scope changes flow state→URL only). When a scan lands with a different scope than the URL (e.g. someone rescanned without the param), reconcile URL ← report.scope silently (replace, not push).
- `openFile` consumers (CodePage/App passing issues to CodePane) read the `file` search param via `Route.useSearch()`.

**Server fallback (`src/server/index.ts`):**
- After all routes: `app.get('*', ...)` — if path starts with `/api/` return `c.json({error:'not found'},404)`; if the path has a file extension (contains a `.` in the last segment) return 404 (assets already have their own route); else serve the same token-substituted index.html as `GET /` (extract the shell-serving into a shared helper). Host guard already applies (`app.use('*')` runs first).
- Tests: `GET /code` → 200 HTML with token; `GET /api/nope` → 404 JSON; `GET /foo.png` → 404.

**E2E (`tests/e2e/routing.spec.ts`):** navigate Dashboard→Code→open file → URL is `/code?file=…` → reload → still on Code with the same file open → browser Back → previous URL and page render → direct-load `/review` with no pending review → redirected to `/code`. Sweep existing specs for reload/URL assumptions and update setup only.

Steps:
- [ ] `npm i @tanstack/react-router` (check the version installs clean against React 19.2 / Vite 8; report if peer conflicts).
- [ ] Server fallback + unit tests first (independent, unblocks client work); commit `feat: SPA fallback route for client-side paths (#14)`.
- [ ] Router + migration per the rules above, keeping every existing behavior test green (`tests/client/ui-store.test.ts` shrinks to the surviving store surface — moving/deleting tests for removed state is legitimate).
- [ ] New routing e2e; sweep existing e2e specs.
- [ ] `npm test` + typecheck + `npm run test:e2e`; commit `feat: tanstack-router pages with URL file/workspace state (#14)`.

Verification (orchestrator, browser): URL changes on nav; reload restores page+file; back/forward work; ws param scopes the scan on a fresh load; review guard redirects.

---

### Task P: Command palette + keyboard shortcuts (#25)

**Files:**
- Create: `client/src/components/CommandPalette.tsx`, `client/src/hooks/use-global-shortcuts.ts`
- Modify: `client/src/App.tsx` (mount palette + hook in the root layout), `client/src/components/ui/command.tsx` ONLY if it lacks `CommandDialog` (add the standard shadcn block verbatim)
- Test: `tests/client/` pure helpers (palette item building / shortcut guard), new `tests/e2e/command-palette.spec.ts`

**Palette (CommandDialog, ⌘K/Ctrl+K):** groups —
- **Pages:** the five pages → `router.navigate`.
- **Files:** report files that have issues (dedupe `issue.filePath`, cap visually via cmdk's own filtering) → `/code?file=<path>` + bump nonce. Label: path; keep value = path for cmdk matching.
- **Workspaces:** entries as in WorkspaceSwitcher (All + report.workspaces) → same semantics INCLUDING the selection-discard confirm and busy/reviewing gates — extract WorkspaceSwitcher's `select/runSwitch/confirm` flow into a small shared hook (`useWorkspaceSwitch`) both consume rather than duplicating it.
- **Actions:** "Re-run scan" (disabled while busy/reviewing — same gate as GitFooter), "Toggle filter: <type>" for the current page's chips when on code/packages.
- Palette closes on action; busy-gated items render disabled with the reason, not hidden.

**Bare shortcuts (`use-global-shortcuts.ts`):** `⌘K`/`Ctrl+K` toggle palette; `r` rescan (same gate); `1`–`5` pages (dashboard/code/packages/ignored/activity); `/` focus the Code page's tree filter input (add a focus ref/registry — only when on `/code`, else navigate there first). Guards: ignore when `event.target` is input/textarea/select/contenteditable, when any modifier is held (except the ⌘K combo), when the palette or any dialog is open (`document.querySelector('[role=dialog]')` or a state check), and shortcuts that mutate (r) are inert on `/review`.
- Pure helper `shortcutAction(key, ctx): Action | null` unit-tested (typing-context ignored; review-page gating; unknown keys null).

**E2E:** ⌘K opens palette → type a filename → Enter → Code page with the file open; `2` switches to Code; `r` triggers a rescan (assert via scanned-at change or busy spinner); `/` focuses the filter box.

Steps:
- [ ] Check `ui/command.tsx` for `CommandDialog`; add the standard shadcn block if missing.
- [ ] Failing unit tests for `shortcutAction`; implement hook + palette + `useWorkspaceSwitch` extraction.
- [ ] E2E spec; full suite + typecheck; commit `feat: command palette and keyboard shortcuts (#25)`.

Verification (orchestrator, browser): all four shortcut classes + palette flows above, light/dark.

---

## Final verification (orchestrator)

- [ ] `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`.
- [ ] Browser pass: #22 mixed-mode preview; #14 URL/reload/back-forward/ws-boot-rescan; #25 palette + shortcuts.
- [ ] Merge to main, push, close #22/#14/#25 with verification comments; file any new issues found.
