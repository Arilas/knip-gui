import { describe, expect, it } from 'vitest';
import { affectedFilePaths, buildFileRail, isAllStale, shouldRestoreOpenFile } from '../../client/src/lib/review.js';

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

describe('shouldRestoreOpenFile (#6 — restore the pre-review open file on Review exit)', () => {
  it('restores on Cancel from idle (never even previewed, so nothing could have been deleted)', () => {
    expect(
      shouldRestoreOpenFile({
        returnTo: 'code',
        returnOpenFile: 'src/used.ts',
        applied: false,
        deletedOkPaths: [],
      }),
    ).toBe(true);
  });

  it('restores after an applied fix that left the open file untouched (not among deletedOkPaths)', () => {
    expect(
      shouldRestoreOpenFile({
        returnTo: 'code',
        returnOpenFile: 'src/used.ts',
        applied: true,
        deletedOkPaths: ['src/other-deleted.ts'],
      }),
    ).toBe(true);
  });

  it('does NOT restore when the open file was delete-applied ok', () => {
    expect(
      shouldRestoreOpenFile({
        returnTo: 'code',
        returnOpenFile: 'src/used.ts',
        applied: true,
        deletedOkPaths: ['src/used.ts'],
      }),
    ).toBe(false);
  });

  it('does NOT restore when returnTo is not code (the file pane is page-scoped — restoring here would leak it onto an unrelated page)', () => {
    expect(
      shouldRestoreOpenFile({
        returnTo: 'packages',
        returnOpenFile: 'src/used.ts',
        applied: false,
        deletedOkPaths: [],
      }),
    ).toBe(false);
  });

  it('does NOT restore when nothing was open before the review started', () => {
    expect(
      shouldRestoreOpenFile({
        returnTo: 'code',
        returnOpenFile: undefined,
        applied: false,
        deletedOkPaths: [],
      }),
    ).toBe(false);
  });

  it('still restores a file the deletion check merely coincides with in name when applied is false (e.g. Cancel mid-preview, before any real apply outcome exists)', () => {
    // Guards against a sloppy implementation that checks deletedOkPaths.includes(...)
    // without gating on `applied` first — deletedOkPaths should only ever be
    // non-empty when applied is true, but this pins the precedence anyway.
    expect(
      shouldRestoreOpenFile({
        returnTo: 'code',
        returnOpenFile: 'src/used.ts',
        applied: false,
        deletedOkPaths: ['src/used.ts'],
      }),
    ).toBe(true);
  });
});

describe('isAllStale (#9 — the frozen review header can outlive the live selection)', () => {
  it('is true when idle, the live selection is empty, and a review was actually frozen', () => {
    expect(isAllStale('idle', 0, 3)).toBe(true);
  });

  it('is false when the live selection is non-empty, even at idle', () => {
    expect(isAllStale('idle', 1, 3)).toBe(false);
  });

  it('is false when frozenCount is 0 (nothing was ever selected — not "gone stale")', () => {
    expect(isAllStale('idle', 0, 0)).toBe(false);
  });

  it('is false once the flow has moved beyond idle, even with an empty live selection (a mid-flow prune must not yank an in-progress/completed plan out from under the user)', () => {
    expect(isAllStale('previewed', 0, 3)).toBe(false);
    expect(isAllStale('previewing', 0, 3)).toBe(false);
    expect(isAllStale('applying', 0, 3)).toBe(false);
    expect(isAllStale('applied', 0, 3)).toBe(false);
    expect(isAllStale('failed', 0, 3)).toBe(false);
  });
});
