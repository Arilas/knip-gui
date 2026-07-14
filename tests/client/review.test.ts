import { describe, expect, it } from 'vitest';
import { affectedFilePaths, buildFileRail } from '../../client/src/lib/review.js';

describe('buildFileRail', () => {
  it('marks every diffed file pending when no results have landed yet (preview step)', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/b.ts' }, { filePath: 'src/a.ts' }],
      [],
    );
    expect(rows).toEqual([
      { filePath: 'src/a.ts', status: 'pending' },
      { filePath: 'src/b.ts', status: 'pending' },
    ]);
  });

  it('sorts rows by filePath', () => {
    const rows = buildFileRail(
      [{ filePath: 'z.ts' }, { filePath: 'a.ts' }, { filePath: 'm.ts' }],
      [],
    );
    expect(rows.map((r) => r.filePath)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('maps ok/stale/missing/io-error results onto their matching diffed file', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/a.ts' }, { filePath: 'src/b.ts' }, { filePath: 'src/c.ts' }, { filePath: 'src/d.ts' }],
      [],
      [
        { filePath: 'src/a.ts', ok: true },
        { filePath: 'src/b.ts', ok: false, reason: 'stale', detail: 'file changed on disk' },
        { filePath: 'src/c.ts', ok: false, reason: 'missing' },
        { filePath: 'src/d.ts', ok: false, reason: 'io-error', detail: 'EACCES' },
      ],
    );
    expect(rows).toEqual([
      { filePath: 'src/a.ts', status: 'ok' },
      { filePath: 'src/b.ts', status: 'stale', reason: 'file changed on disk' },
      { filePath: 'src/c.ts', status: 'missing' },
      { filePath: 'src/d.ts', status: 'io-error', reason: 'EACCES' },
    ]);
  });

  it('gives a diffed file with no matching apply result a "missing" row once results have landed', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/a.ts' }],
      [],
      [], // results landed (empty array, not undefined) but src/a.ts isn't among them
    );
    expect(rows).toEqual([
      { filePath: 'src/a.ts', status: 'missing', reason: 'no apply result received for this file' },
    ]);
  });

  it('reports a compile-failed item that never produced a diff (e.g. a dependency-shaped issue)', () => {
    const rows = buildFileRail(
      [],
      [{ filePath: 'package.json', ok: false, reason: 'transform failed' }],
    );
    expect(rows).toEqual([{ filePath: 'package.json', status: 'compile-failed', reason: 'transform failed' }]);
  });

  it('compile-failed takes precedence over a file-level result for the same file', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/a.ts' }],
      [{ filePath: 'src/a.ts', ok: false, reason: 'transform failed' }],
      [{ filePath: 'src/a.ts', ok: true }],
    );
    expect(rows).toEqual([{ filePath: 'src/a.ts', status: 'compile-failed', reason: 'transform failed' }]);
  });

  it('joins multiple compile-failed reasons for the same file', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/a.ts' }],
      [
        { filePath: 'src/a.ts', ok: false, reason: 'first transform failed' },
        { filePath: 'src/a.ts', ok: false, reason: 'second transform failed' },
      ],
    );
    expect(rows).toEqual([
      { filePath: 'src/a.ts', status: 'compile-failed', reason: 'first transform failed; second transform failed' },
    ]);
  });

  it('ignores ok:true items entirely (they carry no rail status of their own)', () => {
    const rows = buildFileRail(
      [{ filePath: 'src/a.ts' }],
      [{ filePath: 'src/a.ts', ok: true }],
    );
    expect(rows).toEqual([{ filePath: 'src/a.ts', status: 'pending' }]);
  });

  it('does not fabricate a row for an ok:true item whose filePath differs from any diff (dependency-shaped issues)', () => {
    // A dependency-shaped issue's pre-resolved filePath is the issue's own
    // package.json — never where its actual fix/ignore patch lands (a
    // workspace package.json for fix, the knip config file for ignore). An
    // ok:true item reporting that filePath must not add a bogus extra row
    // for a file that was never diffed and will never get an apply result.
    const rows = buildFileRail(
      [{ filePath: 'knip.json' }],
      [{ filePath: 'package.json', ok: true }],
    );
    expect(rows).toEqual([{ filePath: 'knip.json', status: 'pending' }]);
  });

  it('returns an empty rail for no diffs and no items', () => {
    expect(buildFileRail([], [])).toEqual([]);
  });
});

describe('affectedFilePaths', () => {
  it('dedupes and sorts filePaths from a list of issues', () => {
    expect(
      affectedFilePaths([{ filePath: 'src/b.ts' }, { filePath: 'src/a.ts' }, { filePath: 'src/b.ts' }]),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns an empty array for no issues', () => {
    expect(affectedFilePaths([])).toEqual([]);
  });
});
