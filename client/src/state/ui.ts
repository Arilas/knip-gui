// Navigation + per-page filter state for the shadcn app shell (Task 1, UX
// overhaul). Zustand's vanilla store API (getState/setState) makes this
// directly unit-testable without rendering React — same pattern as
// selection.ts (see tests/client/ui-store.test.ts).
//
// `navigate` is the single entry point pages/sidebar/dashboard tiles use to
// move around: it always sets `page` and always touches `openFile` (set when
// `opts.openFile` is given, cleared otherwise — a file pane is page-scoped, so
// leaving it stale across a navigation would show the wrong file's pane).
// Filters behave differently on purpose: they're a *replace*, not a toggle,
// and only when explicitly supplied — omitting `opts.filters` leaves the
// target page's current filter set untouched, so e.g. clicking a sidebar nav
// item (no filters) never resets whatever chips the user had toggled on that
// page. `filters` always apply to the PAGE BEING NAVIGATED TO (`page`
// argument), not whatever page was previously active.
//
// `codeSearch` (Task 2, Dashboard) is a cheap path-prefix scope for the Code
// page's tree — set by a Dashboard workspace-table cell/row click to
// `<workspace>/` so the tree shows just that workspace's files without a
// rescan (the real, rescanning workspace switcher lives in the sidebar).
// Like `filters`, it's a replace-when-given: `opts.search` (including `''`,
// which explicitly clears it) is only applied when the key is present in
// `opts` at all — omitting it (e.g. a plain sidebar nav click) leaves
// whatever search the Code page already had untouched, same rationale as
// filters above. It's also only ever applied when navigating TO the Code
// page: PackagesPage keeps its own local search state and never reads
// codeSearch, so a Dashboard packages-cell click passing `search` alongside
// a non-'code' page would otherwise silently pollute codeSearch for a later,
// unrelated Code visit.
//
// `review` (Task 2, v0.3): the pending review-flow request SelectionDock's
// (eventual, Task 3) Fix…/Ignore… compile step hands off to the 'review'
// page. `startReview` freezes `summary`/`frozenCount` at the moment it's
// called (the design spec's "kills the 'Ignore 0 issues' bug" — the count
// shown on the Review page must reflect what was selected when the plan was
// compiled, not whatever the live selection is by the time it renders) and
// records `returnTo` (the page Cancel navigates back to). `clearReview`
// drops it — called on Cancel/Apply-done, and defensively by App.tsx if
// 'review' is ever the active page with no pending review (direct nav/reload
// edge case — Task 3's redirect-to-Code guard). This task only adds the
// state shape; nothing in the UI calls startReview yet (SelectionDock's
// Fix/Ignore keep opening the existing ActionModal — see SelectionDock.tsx's
// doc comment), so 'review' is a reachable Page value but not yet a
// reachable one in practice.
//
// Tree-expansion lift (Task 2, v0.3): `expandedDirs` used to be TreeView.tsx
// local state (a `manualExpandedDirs: Set<string> | null` — null meaning
// "untouched, use the auto-expand policy"). Lifting it here is what makes
// expansion survive a Code -> Packages -> Code round trip (the old state
// died with the component on unmount). The null-sentinel doesn't translate
// directly to a *store* value, though: a plain empty Set can't distinguish
// "never seeded" from "user clicked Collapse all" — collapsing to empty must
// NOT look identical to "not seeded yet" or TreeView's seeding effect would
// immediately re-expand it right back on the next render, making Collapse
// all a no-op. `expandedDirsInitialized` is the explicit flag that resolves
// that ambiguity: `initExpandedDirs` (called once, by TreeView's mount/tree-
// change effect) only ever applies while `false`, and every other mutator
// (`toggleDir`/`expandAll`/`collapseAll`) sets it `true` — once true, it
// stays true for the rest of the session, so the auto-expand policy only
// ever runs once, and never again re-seeds over a user's explicit choice
// (including an explicit collapse-to-empty).
import { create } from 'zustand';
import type { IssueType } from '../../../src/core/types.js';
import { CODE_TYPES, PACKAGE_TYPES } from '../lib/filters.js';

export type Page = 'dashboard' | 'code' | 'packages' | 'ignored' | 'activity' | 'review';

// Re-exported for existing/older import sites (Dashboard.tsx, tests) — the
// canonical definitions now live in lib/filters.ts (Task 3), alongside the
// rest of the filter/type helpers that consume them.
export { CODE_TYPES, PACKAGE_TYPES };

export interface ReviewRequest {
  kind: 'fix' | 'ignore';
  planId?: string;
  /** Frozen at startReview time — pluralized, e.g. "3 exports, 1 file" (see lib/pluralize.ts). */
  summary: string;
  /** Frozen selection count at startReview time — the count actually shown, immune to the live selection changing under the Review page. */
  frozenCount: number;
  /** Page Cancel/Done navigates back to. */
  returnTo: Page;
}

export interface UiState {
  page: Page;
  codeFilters: Set<IssueType>;
  packagesFilters: Set<IssueType>;
  codeSearch: string;
  openFile?: string;
  review?: ReviewRequest;
  expandedDirs: Set<string>;
  expandedDirsInitialized: boolean;
  navigate: (page: Page, opts?: { filters?: IssueType[]; openFile?: string; search?: string }) => void;
  toggleCodeFilter: (type: IssueType) => void;
  togglePackagesFilter: (type: IssueType) => void;
  // Narrow setter for the Code page's own search input (Task 3): unlike
  // `navigate`'s `search` option (a replace-when-navigating-TO-the-page
  // value, meant for cross-page callers like Dashboard's cell click), this
  // updates codeSearch in place without touching `page` or `openFile` — a
  // keystroke in the search box must never clear whatever file is open in
  // the split's right pane.
  setCodeSearch: (search: string) => void;
  startReview: (request: ReviewRequest) => void;
  clearReview: () => void;
  toggleDir: (path: string) => void;
  expandAll: (paths: Iterable<string>) => void;
  collapseAll: () => void;
  // Seeds expandedDirs from the auto-expand policy exactly once per session
  // — a no-op once expandedDirsInitialized is already true. Not meant to be
  // called from a button; TreeView.tsx's mount/tree-change effect is the one
  // caller (see this file's tree-expansion doc comment above).
  initExpandedDirs: (paths: Iterable<string>) => void;
}

export const useUiStore = create<UiState>((set) => ({
  page: 'dashboard',
  codeFilters: new Set(CODE_TYPES),
  packagesFilters: new Set(PACKAGE_TYPES),
  codeSearch: '',
  openFile: undefined,
  review: undefined,
  expandedDirs: new Set<string>(),
  expandedDirsInitialized: false,

  navigate: (page, opts) =>
    set((state) => {
      const next: Partial<UiState> = { page, openFile: opts?.openFile };
      if (opts?.filters) {
        if (page === 'code') next.codeFilters = new Set(opts.filters);
        else if (page === 'packages') next.packagesFilters = new Set(opts.filters);
      }
      // codeSearch is Code-page-only state (PackagesPage keeps its own local
      // search) — guard here too, defense-in-depth against any future caller
      // that navigates elsewhere while still passing `search`.
      if (opts?.search !== undefined && page === 'code') next.codeSearch = opts.search;
      return next;
    }),

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

  startReview: (request) => set({ page: 'review', review: request }),

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
}));
