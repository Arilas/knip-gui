import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_TYPES, PACKAGE_TYPES, useUiStore } from '../../client/src/state/ui.js';

function resetStore() {
  useUiStore.setState({
    page: 'dashboard',
    codeFilters: new Set(CODE_TYPES),
    packagesFilters: new Set(PACKAGE_TYPES),
    codeSearch: '',
    openFile: undefined,
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
