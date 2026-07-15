// Per-page filter/search/review/tree state for the shadcn app shell. Zustand's
// vanilla store API (getState/setState) makes this directly unit-testable
// without rendering React — same pattern as selection.ts (see
// tests/client/ui-store.test.ts).
//
// NAVIGATION LIVES IN THE URL now (Task R, #14): the active page and the
// currently-open Code file are TanStack Router state (the pathname and
// `/code`'s `file` search param), not store fields — see client/src/router.tsx.
// What stays here is the state the router has no natural home for: the per-page
// filter chip sets, the Code tree's path-prefix search, the pending review
// request, the tree-expansion set, and the open-file re-scroll nonce below.
//
// Filters are a *replace*, not a toggle, and the `setCodeFilters`/
// `setPackagesFilters` setters exist for the Dashboard tile/cell handoff: a
// tile click sets the target page's chip set THEN routes to it (router.navigate
// in Dashboard.tsx), reproducing the old `navigate(page, {filters})` replace
// semantics. A plain sidebar nav (a `<Link>` with no filters) never touches the
// chip sets, so whatever the user toggled on a page survives navigating away
// and back — the behavior the old omit-`opts.filters` branch protected.
//
// `codeSearch` is a cheap path-prefix scope for the Code page's tree — set by a
// Dashboard workspace-table cell/row click to `<workspace>/` so the tree shows
// just that workspace's files without a rescan (the real, rescanning workspace
// switcher lives in the sidebar). Code-page-only: PackagesPage keeps its own
// local search and never reads codeSearch.
//
// `review` (v0.3): the pending review-flow request SelectionDock's Fix…/Ignore…
// buttons hand off to the `/review` route. `startReview` freezes
// `summary`/`frozenCount` at click time (the design spec's "kills the 'Ignore 0
// issues' bug" — the count shown on Review must reflect what was selected when
// Fix…/Ignore… was clicked, not the live selection by the time it renders) and
// records `returnTo` (the PATH Cancel/Done routes back to) plus `returnOpenFile`
// (#6 — the Code file that was open, restored on exit as `/code`'s `file`
// param). Both are supplied by the caller now: openFile is a URL param, not a
// store field, so SelectionDock reads the current location/`file` param and
// passes them in — startReview no longer pulls openFile from the store (there
// is none). `clearReview` drops the request (Cancel/Done); the `/review` route's
// `beforeLoad` guard redirects to `/code` when it's absent (direct nav/reload).
//
// Tree-expansion lift (v0.3): `expandedDirs` used to be TreeView.tsx local
// state (a `manualExpandedDirs: Set<string> | null` — null meaning "untouched,
// use the auto-expand policy"). Lifting it here is what makes expansion survive
// a Code -> Packages -> Code round trip (the old state died with the component
// on unmount). The null-sentinel doesn't translate to a *store* value, though:
// a plain empty Set can't distinguish "never seeded" from "user clicked Collapse
// all" — collapsing to empty must NOT look identical to "not seeded yet" or
// TreeView's seeding effect would immediately re-expand it on the next render,
// making Collapse all a no-op. `expandedDirsInitialized` resolves that:
// `initExpandedDirs` (called once, by TreeView's mount/tree-change effect) only
// applies while `false`, and every other mutator (`toggleDir`/`expandAll`/
// `collapseAll`) sets it `true` — once true it stays true, so the auto-expand
// policy runs once and never re-seeds over a user's explicit choice (including
// an explicit collapse-to-empty).
import { create } from 'zustand';
import type { IssueType } from '../../../src/core/types.js';
import { CODE_TYPES, PACKAGE_TYPES } from '../lib/filters.js';

// Re-exported for existing/older import sites (Dashboard.tsx, tests) — the
// canonical definitions now live in lib/filters.ts, alongside the rest of the
// filter/type helpers that consume them.
export { CODE_TYPES, PACKAGE_TYPES };

export interface ReviewRequest {
  kind: 'fix' | 'ignore';
  /** Frozen at startReview time — pluralized, e.g. "3 exports, 1 file" (see lib/pluralize.ts). */
  summary: string;
  /** Frozen selection count at startReview time — the count actually shown, immune to the live selection changing under the Review page. */
  frozenCount: number;
  /** Router path Cancel/Done routes back to (e.g. "/code"), captured by the caller at click time. */
  returnTo: string;
  /**
   * The Code file that was open when review started (the `/code` `file` search
   * param, read by SelectionDock at click time). Restored as that param on exit
   * unless the fix/ignore run deleted it — see ReviewPage's handleLeave /
   * lib/review.ts's shouldRestoreOpenFile. `undefined` when nothing was open.
   */
  returnOpenFile?: string;
}

export interface UiState {
  codeFilters: Set<IssueType>;
  packagesFilters: Set<IssueType>;
  codeSearch: string;
  // Bumped by `bumpOpenFileNonce` on every explicit file OPEN (a tree-row
  // click), even when it re-opens the file that's already open. CodePane's
  // auto-scroll-to-first-issue effect (v0.3) keys off `${file}#${openFileNonce}`
  // rather than the file path alone: the router will NOT re-render on a
  // navigation to an identical URL (re-clicking the already-open row is a no-op
  // route change), so without a separately-changing signal the scroll/pulse
  // would never re-fire. The nonce is that signal — a store write always
  // re-renders CodePage's subscriber even when the URL didn't move.
  openFileNonce: number;
  review?: ReviewRequest;
  expandedDirs: Set<string>;
  expandedDirsInitialized: boolean;
  // Replace-style setters for the Dashboard tile/cell handoff (see the file's
  // filters doc comment): set the target page's chip set, then Dashboard routes
  // to that page. Not toggles — a fresh, single-type set every time.
  setCodeFilters: (types: IssueType[]) => void;
  setPackagesFilters: (types: IssueType[]) => void;
  toggleCodeFilter: (type: IssueType) => void;
  togglePackagesFilter: (type: IssueType) => void;
  // Narrow setter for the Code page's own search input: updates codeSearch in
  // place. A keystroke in the search box must never affect anything else.
  setCodeSearch: (search: string) => void;
  // See openFileNonce above — CodePage's tree-row click calls this so
  // re-clicking the already-open file still re-fires CodePane's scroll/pulse.
  bumpOpenFileNonce: () => void;
  startReview: (request: ReviewRequest) => void;
  clearReview: () => void;
  toggleDir: (path: string) => void;
  expandAll: (paths: Iterable<string>) => void;
  collapseAll: () => void;
  // Seeds expandedDirs from the auto-expand policy exactly once per session — a
  // no-op once expandedDirsInitialized is already true. Not meant to be called
  // from a button; TreeView.tsx's mount/tree-change effect is the one caller.
  initExpandedDirs: (paths: Iterable<string>) => void;
  // Seed-delta (v0.3): additive-only merge, called AFTER expandedDirsInitialized
  // is already true, for directory paths a rescan introduces that didn't exist
  // at seed (or any prior rescan) time. Deliberately does NOT touch
  // expandedDirsInitialized or remove/collapse anything: only ever adds paths,
  // never overrides an explicit Collapse all/manual collapse of an existing dir.
  expandDirs: (paths: Iterable<string>) => void;
}

export const useUiStore = create<UiState>((set) => ({
  codeFilters: new Set(CODE_TYPES),
  packagesFilters: new Set(PACKAGE_TYPES),
  codeSearch: '',
  openFileNonce: 0,
  review: undefined,
  expandedDirs: new Set<string>(),
  expandedDirsInitialized: false,

  setCodeFilters: (types) => set({ codeFilters: new Set(types) }),
  setPackagesFilters: (types) => set({ packagesFilters: new Set(types) }),

  toggleCodeFilter: (type) =>
    set((state) => {
      const next = new Set(state.codeFilters);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { codeFilters: next };
    }),

  togglePackagesFilter: (type) =>
    set((state) => {
      const next = new Set(state.packagesFilters);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { packagesFilters: next };
    }),

  setCodeSearch: (search) => set({ codeSearch: search }),

  bumpOpenFileNonce: () => set((state) => ({ openFileNonce: state.openFileNonce + 1 })),

  startReview: (request) => set({ review: request }),

  clearReview: () => set({ review: undefined }),

  toggleDir: (path) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedDirs: next, expandedDirsInitialized: true };
    }),

  expandAll: (paths) => set({ expandedDirs: new Set(paths), expandedDirsInitialized: true }),

  collapseAll: () => set({ expandedDirs: new Set<string>(), expandedDirsInitialized: true }),

  initExpandedDirs: (paths) =>
    set((state) =>
      state.expandedDirsInitialized ? state : { expandedDirs: new Set(paths), expandedDirsInitialized: true },
    ),

  expandDirs: (paths) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      let changed = false;
      for (const path of paths) {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? { expandedDirs: next } : state;
    }),
}));
