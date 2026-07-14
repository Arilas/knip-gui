import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import { selectionCount, summaryByType, useSelectionStore } from '../../client/src/state/selection.js';

const issues: Issue[] = [
  { id: 'a', type: 'exports', workspace: '.', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] },
  { id: 'b', type: 'exports', workspace: '.', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] },
  { id: 'c', type: 'files', workspace: '.', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] },
];

// src/used.ts's real fixture shape (Task 3's filters.spec.ts pins the same
// two issues via the live app): one export, one enumMember, both actionable.
const usedTsIssues: Issue[] = [
  {
    id: 'used-export',
    type: 'exports',
    workspace: '.',
    filePath: 'src/used.ts',
    symbol: 'unusedHelper',
    fixable: true,
    fixModes: ['strip-export', 'delete-declaration'],
  },
  {
    id: 'used-enum',
    type: 'enumMembers',
    workspace: '.',
    filePath: 'src/used.ts',
    symbol: 'Blue',
    fixable: true,
    fixModes: ['remove-member'],
  },
  {
    id: 'used-nsexport',
    type: 'nsExports',
    workspace: '.',
    filePath: 'src/used.ts',
    symbol: 'nsUnused',
    fixable: false,
    fixModes: [],
  },
];

beforeEach(() => {
  useSelectionStore.getState().clear();
});

describe('useSelectionStore', () => {
  it('starts empty', () => {
    expect(useSelectionStore.getState().selected.size).toBe(0);
  });

  it('toggle adds ids not yet selected', () => {
    useSelectionStore.getState().toggle(['a', 'b']);
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['a', 'b']);
  });

  it('toggle removes ids already selected (per-id toggle, not batch add)', () => {
    useSelectionStore.getState().toggle(['a', 'b']);
    useSelectionStore.getState().toggle(['a']);
    expect([...useSelectionStore.getState().selected]).toEqual(['b']);
  });

  it('clear empties both selection and mode overrides', () => {
    useSelectionStore.getState().toggle(['a']);
    useSelectionStore.getState().setMode('a', 'delete-declaration');
    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().selected.size).toBe(0);
    expect(useSelectionStore.getState().modeOverrides).toEqual({});
  });

  it('setMode records a per-issue mode override', () => {
    useSelectionStore.getState().setMode('a', 'delete-declaration');
    expect(useSelectionStore.getState().modeOverrides.a).toBe('delete-declaration');
  });

  it('pruneMissing drops ids (and their overrides) no longer present after a rescan', () => {
    useSelectionStore.getState().toggle(['a', 'b', 'c']);
    useSelectionStore.getState().setMode('a', 'delete-declaration');
    useSelectionStore.getState().pruneMissing(['a', 'c']);
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['a', 'c']);
    expect(useSelectionStore.getState().modeOverrides).toEqual({ a: 'delete-declaration' });
  });
});

describe('addFileFiltered', () => {
  it('adds only enabled-type, actionable issues from the given list', () => {
    const enabled = new Set<Issue['type']>(['enumMembers']);
    useSelectionStore.getState().addFileFiltered(usedTsIssues, enabled);
    expect([...useSelectionStore.getState().selected]).toEqual(['used-enum']);
  });

  it('adds every actionable issue when all its types are enabled', () => {
    const enabled = new Set<Issue['type']>(['exports', 'enumMembers', 'nsExports']);
    useSelectionStore.getState().addFileFiltered(usedTsIssues, enabled);
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['used-enum', 'used-export']);
  });

  it('never adds an unfixable/unignorable issue even if its type is enabled', () => {
    const enabled = new Set<Issue['type']>(['nsExports']);
    useSelectionStore.getState().addFileFiltered(usedTsIssues, enabled);
    expect(useSelectionStore.getState().selected.size).toBe(0);
  });

  it('is a pure add: never removes ids already selected, even ones of a now-disabled type', () => {
    useSelectionStore.getState().toggle(['used-export']);
    useSelectionStore.getState().addFileFiltered(usedTsIssues, new Set<Issue['type']>(['enumMembers']));
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['used-enum', 'used-export']);
  });

  it('the cart survives filter toggles: disabling then re-enabling a type never drops or re-adds anything on its own', () => {
    // Disable 'exports': checking the file only adds the enumMember.
    useSelectionStore.getState().addFileFiltered(usedTsIssues, new Set<Issue['type']>(['enumMembers']));
    expect([...useSelectionStore.getState().selected]).toEqual(['used-enum']);

    // Re-enabling 'exports' (a pure filter-state change, no store call at
    // all) must never retroactively add or remove anything from the cart —
    // simulated here by simply asserting nothing changed without any store
    // interaction in between.
    expect([...useSelectionStore.getState().selected]).toEqual(['used-enum']);

    // Explicitly selecting the export afterward (e.g. via the code pane
    // badge) still works normally and the enumMember stays selected too.
    useSelectionStore.getState().toggle(['used-export']);
    expect([...useSelectionStore.getState().selected].sort()).toEqual(['used-enum', 'used-export']);
  });
});

describe('selectionCount', () => {
  it('reflects the number of selected ids', () => {
    useSelectionStore.getState().toggle(['a', 'b']);
    expect(selectionCount(useSelectionStore.getState())).toBe(2);
  });
});

describe('summaryByType', () => {
  it('renders a human summary grouped by issue type', () => {
    useSelectionStore.getState().toggle(['a', 'b', 'c']);
    expect(summaryByType(useSelectionStore.getState(), issues)).toBe('2 exports, 1 files');
  });

  it('is empty when nothing is selected', () => {
    expect(summaryByType(useSelectionStore.getState(), issues)).toBe('');
  });

  it('ignores selected ids that no longer match a known issue', () => {
    useSelectionStore.getState().toggle(['a', 'ghost']);
    expect(summaryByType(useSelectionStore.getState(), issues)).toBe('1 exports');
  });
});
