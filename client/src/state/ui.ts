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
import { create } from 'zustand';
import type { IssueType } from '../../../src/core/types.js';

export type Page = 'dashboard' | 'code' | 'packages' | 'ignored' | 'activity';

// File-located issue types (mirrors facets.ts's FILE_BEARING_TYPES) plus
// unresolved/unlisted — dependency-shaped but still resolvable to a source
// file, so the rebuilt Code page (Task 3) surfaces them there rather than on
// Packages. Exported so future tasks (FilterChips, Dashboard tile routing)
// share this single source of truth instead of redeclaring the list.
export const CODE_TYPES: readonly IssueType[] = [
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'files',
  'duplicates',
  'unresolved',
  'unlisted',
];

// Dependency/package-shaped issue types — everything that lives in a
// package.json rather than a source file.
export const PACKAGE_TYPES: readonly IssueType[] = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'binaries',
];

export interface UiState {
  page: Page;
  codeFilters: Set<IssueType>;
  packagesFilters: Set<IssueType>;
  openFile?: string;
  navigate: (page: Page, opts?: { filters?: IssueType[]; openFile?: string }) => void;
  toggleCodeFilter: (type: IssueType) => void;
  togglePackagesFilter: (type: IssueType) => void;
}

export const useUiStore = create<UiState>((set) => ({
  page: 'dashboard',
  codeFilters: new Set(CODE_TYPES),
  packagesFilters: new Set(PACKAGE_TYPES),
  openFile: undefined,

  navigate: (page, opts) =>
    set((state) => {
      const next: Partial<UiState> = { page, openFile: opts?.openFile };
      if (opts?.filters) {
        if (page === 'code') next.codeFilters = new Set(opts.filters);
        else if (page === 'packages') next.packagesFilters = new Set(opts.filters);
      }
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
}));
