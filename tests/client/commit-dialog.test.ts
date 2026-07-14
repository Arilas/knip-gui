import { describe, expect, it } from 'vitest';
import {
  buildChecklist,
  DEFAULT_COMMIT_MESSAGE,
  defaultCommitDialogMessage,
} from '../../client/src/lib/commit-dialog.js';

describe('buildChecklist', () => {
  it('returns no rows for an empty dirty-file list', () => {
    expect(buildChecklist([], new Set())).toEqual([]);
  });

  it('pre-checks dirty files that are in appliedPaths, marking them knipTouched', () => {
    const rows = buildChecklist(['src/a.ts', 'src/b.ts'], new Set(['src/a.ts']));
    expect(rows).toEqual([
      { path: 'src/a.ts', checked: true, knipTouched: true },
      { path: 'src/b.ts', checked: false, knipTouched: false },
    ]);
  });

  it('preserves the input dirtyFiles order rather than sorting', () => {
    const rows = buildChecklist(['z.ts', 'a.ts'], new Set(['a.ts', 'z.ts']));
    expect(rows.map((r) => r.path)).toEqual(['z.ts', 'a.ts']);
  });

  it('ignores appliedPaths entries that are not currently dirty', () => {
    const rows = buildChecklist(['src/a.ts'], new Set(['src/a.ts', 'src/long-gone.ts']));
    expect(rows).toEqual([{ path: 'src/a.ts', checked: true, knipTouched: true }]);
  });

  it('checks nothing when appliedPaths is empty', () => {
    const rows = buildChecklist(['src/a.ts', 'src/b.ts'], new Set());
    expect(rows.every((r) => !r.checked && !r.knipTouched)).toBe(true);
  });
});

describe('defaultCommitDialogMessage', () => {
  it('falls back to the plain default when nothing is checked', () => {
    const rows = buildChecklist(['a.ts', 'b.ts'], new Set());
    expect(defaultCommitDialogMessage(rows)).toBe(DEFAULT_COMMIT_MESSAGE);
  });

  it('reconciles to a file-count message when every checked row is knip-touched', () => {
    const rows = buildChecklist(['a.ts', 'b.ts'], new Set(['a.ts', 'b.ts']));
    expect(defaultCommitDialogMessage(rows)).toBe('chore(knip): commit 2 files');
  });

  it('singularizes the reconciled message for exactly one checked knip-touched file', () => {
    const rows = buildChecklist(['a.ts'], new Set(['a.ts']));
    expect(defaultCommitDialogMessage(rows)).toBe('chore(knip): commit 1 file');
  });

  it('falls back to the plain default when a checked file is not knip-touched', () => {
    const rows = buildChecklist(['a.ts', 'b.ts'], new Set(['a.ts']));
    // Simulate the user manually checking the unrelated row too.
    const withUnrelatedChecked = rows.map((r) => ({ ...r, checked: true }));
    expect(defaultCommitDialogMessage(withUnrelatedChecked)).toBe(DEFAULT_COMMIT_MESSAGE);
  });

  it('ignores unchecked rows entirely when deciding whether to reconcile', () => {
    // b.ts is dirty-but-unrelated and stays unchecked by default; only the
    // knip-touched a.ts is checked, so the message should still reconcile.
    const rows = buildChecklist(['a.ts', 'b.ts'], new Set(['a.ts']));
    expect(defaultCommitDialogMessage(rows)).toBe('chore(knip): commit 1 file');
  });
});
