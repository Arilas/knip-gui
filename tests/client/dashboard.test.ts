import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import { filterRows, sortRows, typeTotals, visibleColumns, workspaceRows } from '../../client/src/lib/dashboard.js';

function issue(partial: Partial<Issue> & Pick<Issue, 'type' | 'filePath' | 'workspace'>): Issue {
  return {
    id: `${partial.type}-${partial.filePath}-${partial.symbol ?? ''}-${Math.random()}`,
    fixable: false,
    fixModes: [],
    ...partial,
  };
}

const issues: Issue[] = [
  issue({ type: 'files', filePath: 'src/orphan.ts', workspace: '.' }),
  issue({ type: 'files', filePath: 'packages/app/src/dead.ts', workspace: 'packages/app' }),
  issue({ type: 'exports', filePath: 'src/used.ts', workspace: '.', symbol: 'a' }),
  issue({ type: 'exports', filePath: 'src/used.ts', workspace: '.', symbol: 'b' }),
  issue({ type: 'exports', filePath: 'packages/app/src/x.ts', workspace: 'packages/app', symbol: 'c' }),
  issue({ type: 'dependencies', filePath: 'package.json', workspace: '.', symbol: 'left-pad' }),
  issue({ type: 'devDependencies', filePath: 'packages/lib/package.json', workspace: 'packages/lib', symbol: 'x' }),
  issue({ type: 'unlisted', filePath: 'src/index.ts', workspace: '.', symbol: 'unlisted-pkg' }),
];

describe('typeTotals', () => {
  it('counts issues per type, non-zero only', () => {
    const totals = typeTotals(issues);
    expect(totals.map((t) => t.type).sort()).toEqual(
      ['dependencies', 'devDependencies', 'exports', 'files', 'unlisted'].sort(),
    );
    // types absent from the issue list (e.g. 'binaries', 'duplicates') never
    // appear, even with a zero count.
    expect(totals.some((t) => t.type === 'binaries')).toBe(false);
  });

  it('sorts by count descending', () => {
    const totals = typeTotals(issues);
    // exports=3, files=2, then the three 1-counts.
    expect(totals[0]).toEqual({ type: 'exports', count: 3 });
    expect(totals[1]).toEqual({ type: 'files', count: 2 });
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i - 1]!.count).toBeGreaterThanOrEqual(totals[i]!.count);
    }
  });

  it('breaks count ties by ISSUE_TYPES declaration order (stable, not alphabetical)', () => {
    // dependencies, devDependencies, unlisted are all count=1; ISSUE_TYPES
    // declares dependencies before devDependencies before unlisted.
    const totals = typeTotals(issues);
    const tied = totals.filter((t) => t.count === 1).map((t) => t.type);
    expect(tied).toEqual(['dependencies', 'devDependencies', 'unlisted']);
  });

  it('returns an empty array for no issues', () => {
    expect(typeTotals([])).toEqual([]);
  });
});

describe('workspaceRows', () => {
  it('produces one row per workspace present in the issues, with per-type counts and a total', () => {
    const rows = workspaceRows(issues);
    expect(rows.map((r) => r.workspace).sort()).toEqual(['.', 'packages/app', 'packages/lib'].sort());

    const root = rows.find((r) => r.workspace === '.')!;
    expect(root.counts).toEqual({ files: 1, exports: 2, dependencies: 1, unlisted: 1 });
    expect(root.total).toBe(5);

    const app = rows.find((r) => r.workspace === 'packages/app')!;
    expect(app.counts).toEqual({ files: 1, exports: 1 });
    expect(app.total).toBe(2);
  });

  it('never fabricates a row for a workspace with zero issues', () => {
    const rows = workspaceRows(issues);
    expect(rows.some((r) => r.workspace === 'packages/other')).toBe(false);
  });

  it('returns an empty array for no issues', () => {
    expect(workspaceRows([])).toEqual([]);
  });
});

describe('visibleColumns', () => {
  it('lists only types with a non-zero count somewhere, in ISSUE_TYPES declaration order', () => {
    const rows = workspaceRows(issues);
    // ISSUE_TYPES order: files, dependencies, devDependencies, ..., unlisted, ..., exports, ...
    expect(visibleColumns(rows)).toEqual(['files', 'dependencies', 'devDependencies', 'unlisted', 'exports']);
  });

  it('returns an empty array when no rows have any issues', () => {
    expect(visibleColumns([])).toEqual([]);
  });
});

describe('sortRows', () => {
  const rows = workspaceRows(issues);

  it('sorts by total descending', () => {
    const sorted = sortRows(rows, 'total', 'desc');
    expect(sorted.map((r) => r.total)).toEqual([5, 2, 1]);
  });

  it('sorts by total ascending', () => {
    const sorted = sortRows(rows, 'total', 'asc');
    expect(sorted.map((r) => r.total)).toEqual([1, 2, 5]);
  });

  it('sorts by workspace name alphabetically', () => {
    const sorted = sortRows(rows, 'workspace', 'asc');
    expect(sorted.map((r) => r.workspace)).toEqual(['.', 'packages/app', 'packages/lib']);
  });

  it('sorts by workspace name reverse-alphabetically', () => {
    const sorted = sortRows(rows, 'workspace', 'desc');
    expect(sorted.map((r) => r.workspace)).toEqual(['packages/lib', 'packages/app', '.']);
  });

  it('sorts by a specific issue-type column, treating an absent count as 0', () => {
    const sorted = sortRows(rows, 'exports', 'desc');
    expect(sorted.map((r) => r.workspace)).toEqual(['.', 'packages/app', 'packages/lib']);
  });

  it('is stable: rows with equal keys keep their relative input order', () => {
    const tiedRows = [
      { workspace: 'b', counts: {}, total: 3 },
      { workspace: 'a', counts: {}, total: 3 },
      { workspace: 'c', counts: {}, total: 3 },
    ];
    expect(sortRows(tiedRows, 'total', 'desc').map((r) => r.workspace)).toEqual(['b', 'a', 'c']);
    expect(sortRows(tiedRows, 'total', 'asc').map((r) => r.workspace)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortRows(rows, 'workspace', 'asc');
    expect(rows).toEqual(copy);
  });
});

describe('filterRows', () => {
  const rows = workspaceRows(issues);

  it('filters rows whose workspace contains the query, case-insensitively', () => {
    expect(filterRows(rows, 'APP').map((r) => r.workspace)).toEqual(['packages/app']);
  });

  it('returns all rows for an empty (or whitespace-only) query', () => {
    expect(filterRows(rows, '')).toEqual(rows);
    expect(filterRows(rows, '   ')).toEqual(rows);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterRows(rows, 'nonexistent')).toEqual([]);
  });
});
