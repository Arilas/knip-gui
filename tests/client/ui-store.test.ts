import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_TYPES, PACKAGE_TYPES, useUiStore } from '../../client/src/state/ui.js';

function resetStore() {
  useUiStore.setState({
    page: 'dashboard',
    codeFilters: new Set(CODE_TYPES),
    packagesFilters: new Set(PACKAGE_TYPES),
    codeSearch: '',
    openFile: undefined,
    review: undefined,
    expandedDirs: new Set<string>(),
    expandedDirsInitialized: false,
  });
}

beforeEach(() => {
  resetStore();
});

describe('useUiStore defaults', () => {
  it('starts on the dashboard page with no open file', () => {
    expect(useUiStore.getState().page).toBe('dashboard');
    expect(useUiStore.getState().openFile).toBeUndefined();
  });

  it('defaults codeFilters to every file-located type, all enabled', () => {
    expect([...useUiStore.getState().codeFilters].sort()).toEqual(
      ['duplicates', 'enumMembers', 'exports', 'files', 'namespaceMembers', 'types', 'unlisted', 'unresolved'].sort(),
    );
  });

  it('defaults packagesFilters to every dependency-shaped type, all enabled', () => {
    expect([...useUiStore.getState().packagesFilters].sort()).toEqual(
      ['binaries', 'dependencies', 'devDependencies', 'optionalPeerDependencies'].sort(),
    );
  });

  it('defaults codeSearch to empty', () => {
    expect(useUiStore.getState().codeSearch).toBe('');
  });
});

describe('navigate', () => {
  it('switches the active page', () => {
    useUiStore.getState().navigate('code');
    expect(useUiStore.getState().page).toBe('code');
  });

  it('replaces the target page filter set when filters are given', () => {
    useUiStore.getState().navigate('code', { filters: ['exports'] });
    expect([...useUiStore.getState().codeFilters]).toEqual(['exports']);
  });

  it('replaces packagesFilters (not codeFilters) when navigating to packages with filters', () => {
    useUiStore.getState().navigate('packages', { filters: ['dependencies'] });
    expect([...useUiStore.getState().packagesFilters]).toEqual(['dependencies']);
    // codeFilters untouched by a packages-page navigation.
    expect([...useUiStore.getState().codeFilters].sort()).toEqual([...CODE_TYPES].sort());
  });

  it('keeps the current filter set when no filters are given', () => {
    useUiStore.getState().toggleCodeFilter('exports');
    const before = new Set(useUiStore.getState().codeFilters);
    useUiStore.getState().navigate('code');
    expect(useUiStore.getState().codeFilters).toEqual(before);
  });

  it('sets openFile when opts.openFile is given', () => {
    useUiStore.getState().navigate('code', { openFile: 'src/used.ts' });
    expect(useUiStore.getState().openFile).toBe('src/used.ts');
  });

  it('clears openFile on a navigate call that omits opts.openFile', () => {
    useUiStore.getState().navigate('code', { openFile: 'src/used.ts' });
    useUiStore.getState().navigate('code');
    expect(useUiStore.getState().openFile).toBeUndefined();

    useUiStore.getState().navigate('code', { openFile: 'src/used.ts' });
    useUiStore.getState().navigate('packages');
    expect(useUiStore.getState().openFile).toBeUndefined();
  });

  it('sets codeSearch when opts.search is given', () => {
    useUiStore.getState().navigate('code', { search: 'packages/app/' });
    expect(useUiStore.getState().codeSearch).toBe('packages/app/');
  });

  it('clears codeSearch when opts.search is explicitly the empty string', () => {
    useUiStore.getState().navigate('code', { search: 'packages/app/' });
    useUiStore.getState().navigate('code', { search: '' });
    expect(useUiStore.getState().codeSearch).toBe('');
  });

  it('leaves codeSearch untouched when opts.search is omitted', () => {
    useUiStore.getState().navigate('code', { search: 'packages/app/' });
    useUiStore.getState().navigate('code', { filters: ['exports'] });
    expect(useUiStore.getState().codeSearch).toBe('packages/app/');
  });

  it('ignores opts.search when navigating to a page other than code (packages has its own local search)', () => {
    useUiStore.getState().navigate('packages', { filters: ['dependencies'], search: 'packages/app/' });
    expect(useUiStore.getState().page).toBe('packages');
    expect(useUiStore.getState().codeSearch).toBe('');
  });

  it('does not clobber an existing codeSearch when a later non-code navigation also passes opts.search', () => {
    useUiStore.getState().navigate('code', { search: 'packages/app/' });
    useUiStore.getState().navigate('packages', { filters: ['dependencies'], search: 'packages/other/' });
    expect(useUiStore.getState().codeSearch).toBe('packages/app/');
  });
});

describe('setCodeSearch', () => {
  it('updates codeSearch without touching page or openFile', () => {
    useUiStore.getState().navigate('code', { openFile: 'src/used.ts' });
    useUiStore.getState().setCodeSearch('used');
    expect(useUiStore.getState().codeSearch).toBe('used');
    expect(useUiStore.getState().openFile).toBe('src/used.ts');
    expect(useUiStore.getState().page).toBe('code');
  });
});

describe('toggleCodeFilter / togglePackagesFilter', () => {
  it('toggleCodeFilter flips a single type off then on again', () => {
    useUiStore.getState().toggleCodeFilter('exports');
    expect(useUiStore.getState().codeFilters.has('exports')).toBe(false);
    useUiStore.getState().toggleCodeFilter('exports');
    expect(useUiStore.getState().codeFilters.has('exports')).toBe(true);
  });

  it("toggleCodeFilter doesn't affect packagesFilters", () => {
    useUiStore.getState().toggleCodeFilter('exports');
    expect([...useUiStore.getState().packagesFilters].sort()).toEqual([...PACKAGE_TYPES].sort());
  });

  it('togglePackagesFilter flips a single type off then on again', () => {
    useUiStore.getState().togglePackagesFilter('dependencies');
    expect(useUiStore.getState().packagesFilters.has('dependencies')).toBe(false);
    useUiStore.getState().togglePackagesFilter('dependencies');
    expect(useUiStore.getState().packagesFilters.has('dependencies')).toBe(true);
  });
});

describe('startReview / clearReview', () => {
  it('startReview navigates to the review page and freezes the request', () => {
    useUiStore.getState().navigate('code');
    useUiStore.getState().startReview({
      kind: 'fix',
      planId: 'plan-1',
      summary: '2 exports, 1 file',
      frozenCount: 3,
      returnTo: 'code',
    });
    expect(useUiStore.getState().page).toBe('review');
    expect(useUiStore.getState().review).toEqual({
      kind: 'fix',
      planId: 'plan-1',
      summary: '2 exports, 1 file',
      frozenCount: 3,
      returnTo: 'code',
    });
  });

  it('clearReview drops the pending review without touching page', () => {
    useUiStore.getState().startReview({ kind: 'ignore', summary: '1 file', frozenCount: 1, returnTo: 'packages' });
    useUiStore.getState().clearReview();
    expect(useUiStore.getState().review).toBeUndefined();
    // clearReview is a pure state drop (Cancel/Apply-done navigates
    // explicitly elsewhere) — it must not implicitly bounce the page back.
    expect(useUiStore.getState().page).toBe('review');
  });

  it("a later startReview's frozen fields don't leak from an earlier one", () => {
    useUiStore.getState().startReview({ kind: 'fix', summary: '1 export', frozenCount: 1, returnTo: 'code' });
    useUiStore.getState().clearReview();
    useUiStore.getState().startReview({ kind: 'ignore', summary: '2 files', frozenCount: 2, returnTo: 'packages' });
    expect(useUiStore.getState().review).toEqual({
      kind: 'ignore',
      summary: '2 files',
      frozenCount: 2,
      returnTo: 'packages',
    });
  });
});

describe('tree expansion lift (expandedDirs/toggleDir/expandAll/collapseAll/initExpandedDirs)', () => {
  it('starts uninitialized with an empty set', () => {
    expect(useUiStore.getState().expandedDirsInitialized).toBe(false);
    expect(useUiStore.getState().expandedDirs.size).toBe(0);
  });

  it('initExpandedDirs seeds the set once and flips the initialized flag', () => {
    useUiStore.getState().initExpandedDirs(['src', 'src/lib']);
    expect(useUiStore.getState().expandedDirsInitialized).toBe(true);
    expect([...useUiStore.getState().expandedDirs].sort()).toEqual(['src', 'src/lib']);
  });

  it('initExpandedDirs is a no-op once already initialized (never re-seeds over a later choice)', () => {
    useUiStore.getState().initExpandedDirs(['src']);
    useUiStore.getState().collapseAll();
    // Simulates TreeView's seeding effect re-running with a fresh policy
    // default after the tree changed (e.g. a filter chip toggle) — must NOT
    // undo the explicit collapseAll below it.
    useUiStore.getState().initExpandedDirs(['src', 'src/lib', 'src/new-dir']);
    expect(useUiStore.getState().expandedDirs.size).toBe(0);
  });

  it('toggleDir adds an unexpanded dir and removes an expanded one', () => {
    useUiStore.getState().toggleDir('src');
    expect(useUiStore.getState().expandedDirs.has('src')).toBe(true);
    expect(useUiStore.getState().expandedDirsInitialized).toBe(true);
    useUiStore.getState().toggleDir('src');
    expect(useUiStore.getState().expandedDirs.has('src')).toBe(false);
  });

  it('expandAll replaces the set with exactly the given paths', () => {
    useUiStore.getState().toggleDir('stale-dir');
    useUiStore.getState().expandAll(['a', 'b', 'c']);
    expect([...useUiStore.getState().expandedDirs].sort()).toEqual(['a', 'b', 'c']);
    expect(useUiStore.getState().expandedDirsInitialized).toBe(true);
  });

  it('collapseAll empties the set — and, once called, a later seed attempt still cannot re-populate it', () => {
    useUiStore.getState().expandAll(['a', 'b']);
    useUiStore.getState().collapseAll();
    expect(useUiStore.getState().expandedDirs.size).toBe(0);
    useUiStore.getState().initExpandedDirs(['a', 'b']);
    expect(useUiStore.getState().expandedDirs.size).toBe(0);
  });

  it('expandedDirs persists across a navigate call (survives a Code -> Packages -> Code round trip)', () => {
    useUiStore.getState().navigate('code');
    useUiStore.getState().expandAll(['src', 'src/lib']);
    useUiStore.getState().navigate('packages');
    useUiStore.getState().navigate('code');
    expect([...useUiStore.getState().expandedDirs].sort()).toEqual(['src', 'src/lib']);
  });
});
