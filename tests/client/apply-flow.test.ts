// Pure state-machine + join/summary helper tests for the fix/ignore apply
// flow (Task 5). ActionModal.tsx drives applyFlowReducer from its mutation
// callbacks and renders each state as one modal step; none of that wiring is
// exercised here (no React) — that's covered by the manual live serve check
// per Plan 3's Global Constraints (heavy rendering tests stay out).
import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import type { PlanItem } from '../../src/fix/plan.js';
import type { PatchResult } from '../../src/fix/patch.js';
import {
  appliedOkIssueIds,
  applyFlowReducer,
  buildApplyActivityEntry,
  commitPaths,
  defaultBranchName,
  defaultCommitMessage,
  filesToDelete,
  joinResults,
  optionsNextBlocked,
  type ApplyFlowState,
  type DiffEntry,
  type FileResultRow,
} from '../../client/src/lib/apply-flow.js';

let idSeq = 0;
function issue(partial: Partial<Issue> & Pick<Issue, 'type' | 'filePath'>): Issue {
  idSeq += 1;
  return {
    id: `issue-${idSeq}`,
    workspace: '.',
    fixable: true,
    fixModes: [],
    ...partial,
  };
}

describe('applyFlowReducer', () => {
  it('walks idle -> previewing -> previewed -> applying -> applied on the happy path', () => {
    let state: ApplyFlowState = { status: 'idle' };
    state = applyFlowReducer(state, { type: 'preview:start' });
    expect(state).toEqual({ status: 'previewing' });

    const diffs: DiffEntry[] = [{ filePath: 'src/used.ts', diff: '--- a\n+++ b' }];
    const items: PlanItem[] = [{ issueId: 'a', ok: true }];
    state = applyFlowReducer(state, { type: 'preview:success', planId: 'plan-1', diffs, items });
    expect(state).toEqual({ status: 'previewed', planId: 'plan-1', diffs, items });

    state = applyFlowReducer(state, { type: 'apply:start' });
    expect(state).toEqual({ status: 'applying', planId: 'plan-1', diffs, items });

    const results: PatchResult[] = [{ filePath: 'src/used.ts', ok: true }];
    const failedItems: PlanItem[] = [];
    state = applyFlowReducer(state, { type: 'apply:success', results, failedItems, rescanning: true });
    expect(state).toEqual({
      status: 'applied',
      planId: 'plan-1',
      diffs,
      items,
      results,
      failedItems,
      rescanning: true,
    });
  });

  it('moves to failed on preview:error, carrying the prior state', () => {
    const previous: ApplyFlowState = { status: 'previewing' };
    const state = applyFlowReducer(previous, { type: 'preview:error', error: 'boom' });
    expect(state).toEqual({ status: 'failed', error: 'boom', previous });
  });

  it('moves to failed on apply:error, carrying the prior (applying) state', () => {
    const applying: ApplyFlowState = { status: 'applying', planId: 'plan-1', diffs: [], items: [] };
    const state = applyFlowReducer(applying, { type: 'apply:error', error: 'disk full' });
    expect(state).toEqual({ status: 'failed', error: 'disk full', previous: applying });
  });

  it('reset always returns to idle regardless of current state', () => {
    const applied: ApplyFlowState = {
      status: 'applied',
      planId: 'plan-1',
      diffs: [],
      items: [],
      results: [],
      failedItems: [],
      rescanning: false,
    };
    expect(applyFlowReducer(applied, { type: 'reset' })).toEqual({ status: 'idle' });
    expect(applyFlowReducer({ status: 'failed', error: 'x', previous: { status: 'idle' } }, { type: 'reset' })).toEqual({
      status: 'idle',
    });
  });

  it('ignores apply:start when not in previewed (guards against a stray double-click)', () => {
    const idle: ApplyFlowState = { status: 'idle' };
    expect(applyFlowReducer(idle, { type: 'apply:start' })).toBe(idle);
  });

  it('ignores apply:success when not in applying', () => {
    const previewed: ApplyFlowState = { status: 'previewed', planId: 'p', diffs: [], items: [] };
    expect(
      applyFlowReducer(previewed, { type: 'apply:success', results: [], failedItems: [], rescanning: false }),
    ).toBe(previewed);
  });
});

describe('joinResults', () => {
  it('marks a file ok when its apply result succeeded', () => {
    const diffs: DiffEntry[] = [{ filePath: 'src/used.ts', diff: 'd1' }];
    const results: PatchResult[] = [{ filePath: 'src/used.ts', ok: true }];
    expect(joinResults(diffs, results, [])).toEqual([{ filePath: 'src/used.ts', status: 'ok' }]);
  });

  it('surfaces stale/missing/io-error reasons from the patch result', () => {
    const diffs: DiffEntry[] = [
      { filePath: 'a.ts', diff: 'd' },
      { filePath: 'b.ts', diff: 'd' },
      { filePath: 'c.ts', diff: 'd' },
    ];
    const results: PatchResult[] = [
      { filePath: 'a.ts', ok: false, reason: 'stale' },
      { filePath: 'b.ts', ok: false, reason: 'missing' },
      { filePath: 'c.ts', ok: false, reason: 'io-error', detail: 'EACCES' },
    ];
    expect(joinResults(diffs, results, [])).toEqual([
      { filePath: 'a.ts', status: 'stale', reason: undefined },
      { filePath: 'b.ts', status: 'missing', reason: undefined },
      { filePath: 'c.ts', status: 'io-error', reason: 'EACCES' },
    ]);
  });

  it('falls back to missing when a diffed file has no matching apply result', () => {
    const diffs: DiffEntry[] = [{ filePath: 'orphan.ts', diff: 'd' }];
    expect(joinResults(diffs, [], [])).toEqual([
      { filePath: 'orphan.ts', status: 'missing', reason: 'no apply result received for this file' },
    ]);
  });

  it('appends compile-failed rows for planItems with ok:false, using the PlanItem\'s own filePath', () => {
    const diffs: DiffEntry[] = [{ filePath: 'src/used.ts', diff: 'd' }];
    const results: PatchResult[] = [{ filePath: 'src/used.ts', ok: true }];
    const planItems: PlanItem[] = [
      { issueId: 'failed-1', ok: false, reason: 'parse-error', filePath: 'src/shapes.ts' },
    ];
    expect(joinResults(diffs, results, planItems)).toEqual([
      { filePath: 'src/used.ts', status: 'ok' },
      { filePath: 'src/shapes.ts', status: 'compile-failed', reason: 'parse-error' },
    ]);
  });

  it('labels a compile-failed row "unknown file" when the plan item has no filePath', () => {
    const planItems: PlanItem[] = [{ issueId: 'ghost', ok: false, reason: 'gone' }];
    expect(joinResults([], [], planItems)).toEqual([
      { filePath: 'unknown file', status: 'compile-failed', reason: 'gone' },
    ]);
  });
});

describe('defaultCommitMessage', () => {
  it('renders a conventional-commit style "remove" message for a fix plan', () => {
    expect(defaultCommitMessage('12 exports, 3 files', 'fix')).toBe('chore(knip): remove 12 exports, 3 files');
  });

  it('renders a conventional-commit style "ignore" message for an ignore plan', () => {
    expect(defaultCommitMessage('12 exports, 3 files', 'ignore')).toBe('chore(knip): ignore 12 exports, 3 files');
  });

  it('falls back to a generic message when the summary is empty, per plan kind', () => {
    expect(defaultCommitMessage('', 'fix')).toBe('chore(knip): remove unused code');
    expect(defaultCommitMessage('', 'ignore')).toBe('chore(knip): ignore unused code');
  });
});

describe('commitPaths', () => {
  it('extracts the file path list from preview diffs', () => {
    const diffs: DiffEntry[] = [
      { filePath: 'src/used.ts', diff: 'd1' },
      { filePath: 'knip.json', diff: 'd2' },
    ];
    expect(commitPaths(diffs)).toEqual(['src/used.ts', 'knip.json']);
  });

  it('is empty for no diffs', () => {
    expect(commitPaths([])).toEqual([]);
  });
});

describe('filesToDelete', () => {
  it('lists files for selected issues whose effective mode is delete-file', () => {
    const issues: Issue[] = [
      issue({ type: 'files', filePath: 'src/orphan.ts', fixModes: ['delete-file'] }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'unusedHelper', fixModes: ['strip-export', 'delete-declaration'] }),
    ];
    const [fileIssue, exportIssue] = issues;
    const selected = new Set([fileIssue!.id, exportIssue!.id]);
    expect(filesToDelete(issues, selected, {})).toEqual(['src/orphan.ts']);
  });

  it('respects a mode override that changes an export issue to delete-file (n/a in practice, but the helper is mode-driven not type-driven)', () => {
    const issues: Issue[] = [
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'x', fixModes: ['strip-export', 'delete-declaration'] }),
    ];
    const overrides = { [issues[0]!.id]: 'delete-declaration' as const };
    expect(filesToDelete(issues, [issues[0]!.id], overrides)).toEqual([]);
  });

  it('ignores unselected issues even if their mode is delete-file', () => {
    const issues: Issue[] = [issue({ type: 'files', filePath: 'src/orphan.ts', fixModes: ['delete-file'] })];
    expect(filesToDelete(issues, [], {})).toEqual([]);
  });

  it('dedupes and sorts file paths', () => {
    const issues: Issue[] = [
      issue({ type: 'files', filePath: 'src/z.ts', fixModes: ['delete-file'] }),
      issue({ type: 'files', filePath: 'src/a.ts', fixModes: ['delete-file'] }),
    ];
    const selected = issues.map((i) => i.id);
    expect(filesToDelete(issues, selected, {})).toEqual(['src/a.ts', 'src/z.ts']);
  });
});

describe('defaultBranchName', () => {
  it('formats chore/knip-cleanup-<ISO date> from the given date', () => {
    expect(defaultBranchName(new Date('2026-07-13T15:30:00Z'))).toBe('chore/knip-cleanup-2026-07-13');
  });
});

describe('optionsNextBlocked', () => {
  const deletePaths = ['src/orphan.ts'];

  it('blocks Next in fix mode while a pending file deletion is unconfirmed', () => {
    expect(optionsNextBlocked('fix', deletePaths, false)).toBe(true);
  });

  it('unblocks Next in fix mode once the deletion is confirmed', () => {
    expect(optionsNextBlocked('fix', deletePaths, true)).toBe(false);
  });

  it('never blocks Next in ignore mode, even with files-type issues selected (ignore never deletes)', () => {
    // Regression: the confirm checkbox only renders in fix mode, so a
    // mode-agnostic gate left Ignore permanently stuck on the options step
    // for any selection containing a files-type issue.
    expect(optionsNextBlocked('ignore', deletePaths, false)).toBe(false);
  });

  it('does not block fix mode when nothing is being deleted', () => {
    expect(optionsNextBlocked('fix', [], false)).toBe(false);
  });
});

describe('appliedOkIssueIds', () => {
  const okItems: PlanItem[] = [
    { issueId: 'export-1', ok: true, filePath: 'src/used.ts' },
    { issueId: 'file-1', ok: true, filePath: 'src/orphan.ts' },
    { issueId: 'dep-1', ok: true, filePath: 'package.json' },
    { issueId: 'wsdep-1', ok: true, filePath: 'packages/app/package.json' },
  ];

  it('returns every plan-ok issue when all patches applied ok', () => {
    const rows: FileResultRow[] = [
      { filePath: 'src/used.ts', status: 'ok' },
      { filePath: 'src/orphan.ts', status: 'ok' },
      { filePath: 'package.json', status: 'ok' },
      { filePath: 'packages/app/package.json', status: 'ok' },
    ];
    expect(appliedOkIssueIds(okItems, rows)).toEqual(okItems.map((i) => i.issueId));
  });

  it('excludes issues whose file went stale between preview and apply', () => {
    const rows: FileResultRow[] = [
      { filePath: 'src/used.ts', status: 'stale' },
      { filePath: 'src/orphan.ts', status: 'ok' },
    ];
    const items: PlanItem[] = [
      { issueId: 'export-1', ok: true, filePath: 'src/used.ts' },
      { issueId: 'file-1', ok: true, filePath: 'src/orphan.ts' },
    ];
    expect(appliedOkIssueIds(items, rows)).toEqual(['file-1']);
  });

  it('does not credit a dependency issue against issue.filePath when its patch actually landed in the workspace package.json', () => {
    const rows: FileResultRow[] = [{ filePath: 'packages/app/package.json', status: 'missing' }];
    const items: PlanItem[] = [{ issueId: 'wsdep-1', ok: true, filePath: 'packages/app/package.json' }];
    expect(appliedOkIssueIds(items, rows)).toEqual([]);
  });

  it('excludes compile-failed plan items regardless of file outcomes', () => {
    const rows: FileResultRow[] = [
      { filePath: 'src/orphan.ts', status: 'ok' },
      { filePath: 'src/used.ts', status: 'compile-failed', reason: 'parse-error' },
    ];
    const items: PlanItem[] = [
      { issueId: 'file-1', ok: true, filePath: 'src/orphan.ts' },
      { issueId: 'export-1', ok: false, reason: 'parse-error', filePath: 'src/used.ts' },
    ];
    expect(appliedOkIssueIds(items, rows)).toEqual(['file-1']);
  });

  it('counts config-patched issues (filePath not among the diffed files) when every patch row succeeded', () => {
    // An ignore-mode files issue: the patch lands in knip.json, its filePath.
    const rows: FileResultRow[] = [{ filePath: 'knip.json', status: 'ok' }];
    const items: PlanItem[] = [{ issueId: 'file-1', ok: true, filePath: 'knip.json' }];
    expect(appliedOkIssueIds(items, rows)).toEqual(['file-1']);
  });

  it('drops config-patched issues when any patch row failed (undercount rather than overclaim)', () => {
    const rows: FileResultRow[] = [{ filePath: 'knip.json', status: 'stale' }];
    const items: PlanItem[] = [{ issueId: 'file-1', ok: true, filePath: 'knip.json' }];
    expect(appliedOkIssueIds(items, rows)).toEqual([]);
  });

  it('ignores plan items with no filePath (unknown-issue / unattributable failures)', () => {
    const rows: FileResultRow[] = [{ filePath: 'src/used.ts', status: 'ok' }];
    expect(appliedOkIssueIds([{ issueId: 'ghost', ok: true }], rows)).toEqual([]);
  });

  it('an ok item whose file produced no patch counts as applied only when every patch applied ok', () => {
    const rows: FileResultRow[] = [{ filePath: 'a.ts', status: 'ok' }];
    // knip.json edit compiled ok but was a no-op (entry already present) — no patch row for it
    const items: PlanItem[] = [{ issueId: 'i1', ok: true, filePath: 'knip.json' }];
    expect(appliedOkIssueIds(items, rows)).toEqual(['i1']);
    const rowsWithFailure: FileResultRow[] = [{ filePath: 'a.ts', status: 'stale' }];
    expect(appliedOkIssueIds(items, rowsWithFailure)).toEqual([]);
  });
});

describe('buildApplyActivityEntry', () => {
  // #7: this is the pure computation ReviewPage's handleApply calls right
  // after applyMutation.mutateAsync resolves (an async continuation that
  // survives the component unmounting), replacing the old post-render
  // useEffect that silently dropped the log entry whenever the user
  // navigated away during the brief 'applying' window.
  const usedIssue = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'unusedHelper' });
  const at = '2026-07-15T00:00:00.000Z';

  it('builds an entry from ok rows: kind, summary-by-type, and ok-only paths', () => {
    const diffs: DiffEntry[] = [{ filePath: usedIssue.filePath, diff: 'd' }];
    const items: PlanItem[] = [{ issueId: usedIssue.id, ok: true, filePath: usedIssue.filePath }];
    const results: PatchResult[] = [{ filePath: usedIssue.filePath, ok: true }];
    expect(buildApplyActivityEntry(diffs, items, results, [usedIssue], 'fix', 'fallback', at)).toEqual({
      kind: 'fix',
      summary: '1 export',
      paths: ['src/used.ts'],
      at,
    });
  });

  it('returns null when every row failed (nothing to log)', () => {
    const diffs: DiffEntry[] = [{ filePath: usedIssue.filePath, diff: 'd' }];
    const items: PlanItem[] = [{ issueId: usedIssue.id, ok: true, filePath: usedIssue.filePath }];
    const results: PatchResult[] = [{ filePath: usedIssue.filePath, ok: false, reason: 'stale' }];
    expect(buildApplyActivityEntry(diffs, items, results, [usedIssue], 'fix', 'fallback', at)).toBeNull();
  });

  it('falls back to fallbackSummary when summaryByType yields an empty string', () => {
    // The ok'd plan item has no filePath, so appliedOkIssueIds can't
    // attribute it to any patch row and summaryByType sees an empty
    // selection — even though okPaths is non-empty and an entry is still
    // logged.
    const diffs: DiffEntry[] = [{ filePath: 'a.ts', diff: 'd' }];
    const items: PlanItem[] = [{ issueId: 'ghost', ok: true }];
    const results: PatchResult[] = [{ filePath: 'a.ts', ok: true }];
    expect(buildApplyActivityEntry(diffs, items, results, [], 'ignore', 'fallback summary', at)).toEqual({
      kind: 'ignore',
      summary: 'fallback summary',
      paths: ['a.ts'],
      at,
    });
  });
});
