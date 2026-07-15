import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_TYPES, PACKAGE_TYPES, useUiStore } from '../../client/src/state/ui.js';

// Navigation (active page + open file) moved to the URL/router in Task R (#14),
// so the store no longer holds `page`/`openFile`/`navigate` — those behaviors
// are covered by tests/e2e/routing.spec.ts against the real router now. What
// remains here is the store's surviving surface: filter sets + their
// replace/toggle setters, codeSearch, the open-file re-scroll nonce, the
// review request, and the tree-expansion lift.
function resetStore() {
  useUiStore.setState({
    codeFilters: new Set(CODE_TYPES),
    packagesFilters: new Set(PACKAGE_TYPES),
    codeSearch: '',
    openFileNonce: 0,
    review: undefined,
    expandedDirs: new Set<string>(),
    expandedDirsInitialized: false,
  });
}

beforeEach(() => {
  resetStore();
});

describe('useUiStore defaults', () => {
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

  it('defaults codeSearch to empty and the open-file nonce to 0', () => {
    expect(useUiStore.getState().codeSearch).toBe('');
    expect(useUiStore.getState().openFileNonce).toBe(0);
  });
});

describe('setCodeFilters / setPackagesFilters (Dashboard tile/cell replace semantics)', () => {
  it('setCodeFilters replaces the code chip set with exactly the given types', () => {
    useUiStore.getState().setCodeFilters(['exports']);
    expect([...useUiStore.getState().codeFilters]).toEqual(['exports']);
  });

  it('setPackagesFilters replaces packagesFilters and never touches codeFilters', () => {
    useUiStore.getState().setPackagesFilters(['dependencies']);
    expect([...useUiStore.getState().packagesFilters]).toEqual(['dependencies']);
    expect([...useUiStore.getState().codeFilters].sort()).toEqual([...CODE_TYPES].sort());
  });
});

describe('setCodeSearch', () => {
  it('updates codeSearch in place', () => {
    useUiStore.getState().setCodeSearch('packages/app/');
    expect(useUiStore.getState().codeSearch).toBe('packages/app/');
    useUiStore.getState().setCodeSearch('');
    expect(useUiStore.getState().codeSearch).toBe('');
  });
});

describe('bumpOpenFileNonce (CodePane re-scroll signal for an identical-URL re-open)', () => {
  it('increments the nonce on every call — the signal that re-fires the scroll/pulse when the router will not re-navigate', () => {
    const start = useUiStore.getState().openFileNonce;
    useUiStore.getState().bumpOpenFileNonce();
    expect(useUiStore.getState().openFileNonce).toBe(start + 1);
    useUiStore.getState().bumpOpenFileNonce();
    expect(useUiStore.getState().openFileNonce).toBe(start + 2);
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
  it('startReview stores the request verbatim (returnTo/returnOpenFile supplied by the caller — openFile is URL state now)', () => {
    useUiStore.getState().startReview({
      kind: 'fix',
      summary: '2 exports, 1 file',
      frozenCount: 3,
      returnTo: '/code',
      returnOpenFile: 'src/used.ts',
    });
    expect(useUiStore.getState().review).toEqual({
      kind: 'fix',
      summary: '2 exports, 1 file',
      frozenCount: 3,
      returnTo: '/code',
      returnOpenFile: 'src/used.ts',
    });
  });

  it('startReview carries returnOpenFile undefined when nothing was open', () => {
    useUiStore.getState().startReview({ kind: 'fix', summary: '1 export', frozenCount: 1, returnTo: '/code' });
    expect(useUiStore.getState().review?.returnOpenFile).toBeUndefined();
  });

  it('clearReview drops the pending review', () => {
    useUiStore.getState().startReview({ kind: 'ignore', summary: '1 file', frozenCount: 1, returnTo: '/packages' });
    useUiStore.getState().clearReview();
    expect(useUiStore.getState().review).toBeUndefined();
  });

  it("a later startReview's frozen fields don't leak from an earlier one", () => {
    useUiStore.getState().startReview({ kind: 'fix', summary: '1 export', frozenCount: 1, returnTo: '/code' });
    useUiStore.getState().clearReview();
    useUiStore.getState().startReview({ kind: 'ignore', summary: '2 files', frozenCount: 2, returnTo: '/packages' });
    expect(useUiStore.getState().review).toEqual({
      kind: 'ignore',
      summary: '2 files',
      frozenCount: 2,
      returnTo: '/packages',
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

  describe('expandDirs (seed-delta for dirs a rescan introduces post-seed)', () => {
    it('adds paths not already present, without touching existing ones', () => {
      useUiStore.getState().expandAll(['src']);
      useUiStore.getState().expandDirs(['src', 'src/new-dir']);
      expect([...useUiStore.getState().expandedDirs].sort()).toEqual(['src', 'src/new-dir']);
    });

    it('is a no-op (same Set reference) when every path is already present', () => {
      useUiStore.getState().expandAll(['src']);
      const before = useUiStore.getState().expandedDirs;
      useUiStore.getState().expandDirs(['src']);
      expect(useUiStore.getState().expandedDirs).toBe(before);
    });

    it('does not flip expandedDirsInitialized on its own', () => {
      useUiStore.getState().expandDirs(['src']);
      expect(useUiStore.getState().expandedDirsInitialized).toBe(false);
      expect(useUiStore.getState().expandedDirs.has('src')).toBe(true);
    });
  });
});
