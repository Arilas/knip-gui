import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import { FACETS, facetCounts, isFixable, isIgnorable, issuesForFacet } from '../../client/src/lib/facets.js';

function issue(partial: Partial<Issue> & Pick<Issue, 'type' | 'filePath' | 'workspace'>): Issue {
  return {
    id: `${partial.type}-${partial.filePath}-${partial.symbol ?? ''}-${Math.random()}`,
    fixable: false,
    fixModes: [],
    ...partial,
  };
}

const issues: Issue[] = [
  issue({ type: 'files', filePath: 'src/orphan.ts', workspace: '.', fixable: true, fixModes: ['delete-file'] }),
  issue({
    type: 'exports',
    filePath: 'src/used.ts',
    workspace: '.',
    symbol: 'unusedHelper',
    fixable: true,
    fixModes: ['strip-export', 'delete-declaration'],
  }),
  issue({
    type: 'nsExports',
    filePath: 'src/used.ts',
    workspace: '.',
    symbol: 'nsUnused',
    fixable: false,
    fixModes: [],
  }),
  issue({
    type: 'types',
    filePath: 'src/shapes.ts',
    workspace: '.',
    symbol: 'UnusedShape',
    fixable: true,
    fixModes: ['strip-export', 'delete-declaration'],
  }),
  issue({
    type: 'enumMembers',
    filePath: 'src/used.ts',
    workspace: '.',
    symbol: 'Blue',
    parentSymbol: 'Color',
    fixable: true,
    fixModes: ['remove-member'],
  }),
  issue({
    type: 'duplicates',
    filePath: 'src/forms.ts',
    workspace: '.',
    symbol: 'dupeAlias',
    fixable: true,
    fixModes: ['remove-duplicate'],
  }),
  issue({
    type: 'dependencies',
    filePath: 'package.json',
    workspace: '.',
    symbol: 'left-pad',
    fixable: true,
    fixModes: ['remove-dependency'],
  }),
  issue({
    type: 'devDependencies',
    filePath: 'package.json',
    workspace: 'packages/a',
    symbol: 'some-dev-dep',
    fixable: true,
    fixModes: ['remove-dependency'],
  }),
  issue({ type: 'unlisted', filePath: 'src/index.ts', workspace: '.', symbol: 'unlisted-pkg' }),
  issue({ type: 'unresolved', filePath: 'src/index.ts', workspace: '.', symbol: './missing.js' }),
  issue({ type: 'binaries', filePath: 'package.json', workspace: '.', symbol: 'some-bin' }),
];

describe('FACETS', () => {
  it('lists every facet id with a human label, in spec order', () => {
    expect(FACETS.map((f) => f.id)).toEqual([
      'overview',
      'tree',
      'files',
      'exports',
      'types',
      'enumMembers',
      'namespaceMembers',
      'duplicates',
      'dependencies',
      'unlisted',
      'unresolved',
      'binaries',
    ]);
    for (const facet of FACETS) {
      expect(typeof facet.label).toBe('string');
      expect(facet.label.length).toBeGreaterThan(0);
    }
  });
});

describe('issuesForFacet', () => {
  it('tree facet includes every file-bearing type (incl. nsExports) but excludes dependency-shaped types', () => {
    const tree = issuesForFacet('tree', issues);
    expect(tree.map((i) => i.type).sort()).toEqual(
      ['duplicates', 'enumMembers', 'exports', 'files', 'nsExports', 'types'].sort(),
    );
  });

  it('dependencies facet unions the three dependency issue types', () => {
    const deps = issuesForFacet('dependencies', issues);
    expect(deps.map((i) => i.type).sort()).toEqual(['dependencies', 'devDependencies']);
  });

  it('exports facet includes exports and nsExports', () => {
    const exp = issuesForFacet('exports', issues);
    expect(exp.map((i) => i.type).sort()).toEqual(['exports', 'nsExports']);
  });

  it('a plain table facet (binaries) matches only its own type', () => {
    expect(issuesForFacet('binaries', issues).map((i) => i.type)).toEqual(['binaries']);
  });

  it('filters by workspace when given', () => {
    const deps = issuesForFacet('dependencies', issues, 'packages/a');
    expect(deps.map((i) => i.symbol)).toEqual(['some-dev-dep']);
  });

  it('overview facet returns every issue (optionally workspace-scoped)', () => {
    expect(issuesForFacet('overview', issues)).toHaveLength(issues.length);
    expect(issuesForFacet('overview', issues, '.')).toHaveLength(issues.length - 1);
  });
});

describe('facetCounts', () => {
  it('counts issues per real issue type, across all workspaces when none given', () => {
    const counts = facetCounts(issues);
    expect(counts.exports).toBe(1);
    expect(counts.nsExports).toBe(1);
    expect(counts.dependencies).toBe(1);
    expect(counts.devDependencies).toBe(1);
    expect(counts.files).toBe(1);
  });

  it('scopes counts to one workspace', () => {
    const counts = facetCounts(issues, 'packages/a');
    expect(counts.devDependencies).toBe(1);
    expect(counts.dependencies).toBeUndefined();
  });
});

describe('isFixable', () => {
  it('is fixable when the issue carries at least one fix mode', () => {
    const result = isFixable(issues.find((i) => i.type === 'exports')!);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('gives a reason when unfixable', () => {
    const result = isFixable(issues.find((i) => i.type === 'nsExports')!);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('isIgnorable', () => {
  it('export-ish, files, deps and binaries are ignorable', () => {
    for (const type of ['exports', 'types', 'enumMembers', 'files', 'dependencies', 'binaries'] as const) {
      const found = issues.find((i) => i.type === type);
      if (!found) continue;
      expect(isIgnorable(found).ok).toBe(true);
    }
  });

  it('duplicates, nsExports, unlisted and unresolved are not ignorable, with a reason', () => {
    for (const type of ['duplicates', 'nsExports', 'unlisted', 'unresolved'] as const) {
      const found = issues.find((i) => i.type === type);
      if (!found) continue;
      const result = isIgnorable(found);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});
