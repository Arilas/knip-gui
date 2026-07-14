import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import {
  CODE_TYPES,
  filterIssues,
  isActionable,
  isFixable,
  isIgnorable,
  PACKAGE_TYPES,
  typeLabel,
} from '../../client/src/lib/filters.js';

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
  issue({ type: 'unlisted', filePath: 'src/index.ts', workspace: '.', symbol: 'unlisted-pkg' }),
  issue({ type: 'unresolved', filePath: 'src/index.ts', workspace: '.', symbol: './missing.js' }),
  issue({ type: 'binaries', filePath: 'package.json', workspace: '.', symbol: 'some-bin' }),
];

describe('CODE_TYPES / PACKAGE_TYPES', () => {
  it('CODE_TYPES lists every file-located type', () => {
    expect([...CODE_TYPES].sort()).toEqual(
      ['duplicates', 'enumMembers', 'exports', 'files', 'namespaceMembers', 'types', 'unlisted', 'unresolved'].sort(),
    );
  });

  it('PACKAGE_TYPES lists every dependency-shaped type', () => {
    expect([...PACKAGE_TYPES].sort()).toEqual(
      ['binaries', 'dependencies', 'devDependencies', 'optionalPeerDependencies'].sort(),
    );
  });
});

describe('typeLabel', () => {
  it('gives every IssueType a non-empty human label', () => {
    for (const type of [...CODE_TYPES, ...PACKAGE_TYPES, 'nsExports', 'nsTypes', 'catalog', 'cycles'] as const) {
      expect(typeLabel(type).length).toBeGreaterThan(0);
    }
  });

  it('exports a specific, stable label used by the FilterChips tooltip', () => {
    expect(typeLabel('exports')).toBe('Unused exports');
    expect(typeLabel('unlisted')).toBe('Unlisted dependencies');
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

describe('isActionable', () => {
  it('is true when fixable or ignorable', () => {
    expect(isActionable(issues.find((i) => i.type === 'exports')!)).toBe(true);
    expect(isActionable(issues.find((i) => i.type === 'binaries')!)).toBe(true);
  });

  it('is false when neither fixable nor ignorable', () => {
    expect(isActionable(issues.find((i) => i.type === 'nsExports')!)).toBe(false);
    expect(isActionable(issues.find((i) => i.type === 'unlisted')!)).toBe(false);
  });
});

describe('filterIssues', () => {
  it('keeps only issues of an enabled type', () => {
    const enabled = new Set(CODE_TYPES);
    const result = filterIssues(issues, enabled, '');
    expect(result.map((i) => i.type).sort()).toEqual(
      ['duplicates', 'enumMembers', 'exports', 'files', 'types', 'unlisted', 'unresolved'].sort(),
    );
  });

  it('excludes a type once it is disabled', () => {
    const enabled = new Set(CODE_TYPES.filter((t) => t !== 'exports'));
    const result = filterIssues(issues, enabled, '');
    expect(result.some((i) => i.type === 'exports')).toBe(false);
  });

  it('applies a case-insensitive substring match over filePath or symbol', () => {
    const enabled = new Set(CODE_TYPES);
    const result = filterIssues(issues, enabled, 'SHAPES');
    expect(result.map((i) => i.filePath)).toEqual(['src/shapes.ts']);
  });

  it('matches on symbol as well as filePath', () => {
    const enabled = new Set(CODE_TYPES);
    const result = filterIssues(issues, enabled, 'unusedhelper');
    expect(result.map((i) => i.symbol)).toEqual(['unusedHelper']);
  });

  it('an empty/whitespace query is a no-op on top of the type filter', () => {
    const enabled = new Set(CODE_TYPES);
    expect(filterIssues(issues, enabled, '   ')).toHaveLength(filterIssues(issues, enabled, '').length);
  });
});
