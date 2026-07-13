// Pure state-machine + join/summary helper tests for the fix/ignore apply
// flow (Task 5). ActionModal.tsx drives applyFlowReducer from its mutation
// callbacks and renders each state as one modal step; none of that wiring is
// exercised here (no React) — that's covered by the manual live serve check
// per Plan 3's Global Constraints (heavy rendering tests stay out).
import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import type { PlanItem } from '../../src/fix/compiler.js';
import type { PatchResult } from '../../src/fix/patch.js';
import {
  applyFlowReducer,
  commitPaths,
  defaultBranchName,
  defaultCommitMessage,
  filesToDelete,
  joinResults,
  type ApplyFlowState,
  type DiffEntry,
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
  const issues: Issue[] = [
    issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'unusedHelper' }),
    issue({ type: 'exports', filePath: 'src/shapes.ts', symbol: 'UnusedShape' }),
  ];
  const [okIssue, failedIssue] = issues;

  it('marks a file ok when its apply result succeeded', () => {
    const diffs: DiffEntry[] = [{ filePath: 'src/used.ts', diff: 'd1' }];
    const results: PatchResult[] = [{ filePath: 'src/used.ts', ok: true }];
    expect(joinResults(diffs, results, [], issues)).toEqual([{ filePath: 'src/used.ts', status: 'ok' }]);
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
    expect(joinResults(diffs, results, [], [])).toEqual([
      { filePath: 'a.ts', status: 'stale', reason: undefined },
      { filePath: 'b.ts', status: 'missing', reason: undefined },
      { filePath: 'c.ts', status: 'io-error', reason: 'EACCES' },
    ]);
  });

  it('falls back to missing when a diffed file has no matching apply result', () => {
    const diffs: DiffEntry[] = [{ filePath: 'orphan.ts', diff: 'd' }];
    expect(joinResults(diffs, [], [], [])).toEqual([
      { filePath: 'orphan.ts', status: 'missing', reason: 'no apply result received for this file' },
    ]);
  });

  it('appends compile-failed rows for planItems with ok:false, resolving filePath via issues', () => {
    const diffs: DiffEntry[] = [{ filePath: okIssue!.filePath, diff: 'd' }];
    const results: PatchResult[] = [{ filePath: okIssue!.filePath, ok: true }];
    const planItems: PlanItem[] = [{ issueId: failedIssue!.id, ok: false, reason: 'parse-error' }];
    expect(joinResults(diffs, results, planItems, issues)).toEqual([
      { filePath: okIssue!.filePath, status: 'ok' },
      { filePath: failedIssue!.filePath, status: 'compile-failed', reason: 'parse-error' },
    ]);
  });

  it('labels a compile-failed row "unknown file" when the issue id is not found', () => {
    const planItems: PlanItem[] = [{ issueId: 'ghost', ok: false, reason: 'gone' }];
    expect(joinResults([], [], planItems, issues)).toEqual([
      { filePath: 'unknown file', status: 'compile-failed', reason: 'gone' },
    ]);
  });
});

describe('defaultCommitMessage', () => {
  it('renders a conventional-commit style message from a selection summary', () => {
    expect(defaultCommitMessage('12 exports, 3 files')).toBe('chore(knip): remove 12 exports, 3 files');
  });

  it('falls back to a generic message when the summary is empty', () => {
    expect(defaultCommitMessage('')).toBe('chore(knip): remove unused code');
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
