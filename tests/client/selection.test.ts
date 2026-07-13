import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import { selectionCount, summaryByType, useSelectionStore } from '../../client/src/state/selection.js';

const issues: Issue[] = [
  { id: 'a', type: 'exports', workspace: '.', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] },
  { id: 'b', type: 'exports', workspace: '.', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] },
  { id: 'c', type: 'files', workspace: '.', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] },
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
