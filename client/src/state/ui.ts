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
import { create } from 'zustand';
import type { IssueType } from '../../../src/core/types.js';
import { CODE_TYPES, PACKAGE_TYPES } from '../lib/filters.js';

export type Page = 'dashboard' | 'code' | 'packages' | 'ignored' | 'activity';

// Re-exported for existing/older import sites (Dashboard.tsx, tests) — the
// canonical definitions now live in lib/filters.ts (Task 3), alongside the
// rest of the filter/type helpers that consume them.
export { CODE_TYPES, PACKAGE_TYPES };

export interface UiState {
  page: Page;
  codeFilters: Set<IssueType>;
  packagesFilters: Set<IssueType>;
  codeSearch: string;
  openFile?: string;
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
}

export const useUiStore = create<UiState>((set) => ({
  page: 'dashboard',
  codeFilters: new Set(CODE_TYPES),
  packagesFilters: new Set(PACKAGE_TYPES),
  codeSearch: '',
  openFile: undefined,

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
}));
