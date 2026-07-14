import { beforeEach, describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../../client/src/lib/activity.js';
import { appliedPaths, useActivityStore } from '../../client/src/state/activity.js';

beforeEach(() => {
  useActivityStore.getState().clear();
});

describe('useActivityStore', () => {
  it('starts empty', () => {
    expect(useActivityStore.getState().entries).toEqual([]);
  });

  it('log() adds an entry with a unique id', () => {
    useActivityStore.getState().log({ kind: 'fix', summary: '2 exports', at: '2026-07-13T10:00:00.000Z' });
    const { entries } = useActivityStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'fix',
      summary: '2 exports',
      at: '2026-07-13T10:00:00.000Z',
    });
    expect(entries[0]!.id).toEqual(expect.any(Number));
  });

  it('newest-first: the most recently logged entry is at index 0', () => {
    useActivityStore.getState().log({ kind: 'fix', summary: 'first', at: '2026-07-13T10:00:00.000Z' });
    useActivityStore.getState().log({ kind: 'ignore', summary: 'second', at: '2026-07-13T10:01:00.000Z' });
    useActivityStore.getState().log({ kind: 'sweep', summary: 'third', at: '2026-07-13T10:02:00.000Z' });
    const { entries } = useActivityStore.getState();
    expect(entries.map((e) => e.summary)).toEqual(['third', 'second', 'first']);
  });

  it('carries an optional sha (e.g. for a commit entry)', () => {
    useActivityStore.getState().log({
      kind: 'commit',
      summary: 'chore(knip): remove 1 files',
      sha: 'abc1234',
      at: '2026-07-13T10:00:00.000Z',
    });
    expect(useActivityStore.getState().entries[0]!.sha).toBe('abc1234');
  });

  it('omits sha entirely for kinds that have none', () => {
    useActivityStore.getState().log({ kind: 'ignore-remove', summary: 'removed left-pad', at: '2026-07-13T10:00:00.000Z' });
    expect(useActivityStore.getState().entries[0]!.sha).toBeUndefined();
  });

  it('caps at 200 entries, dropping the oldest', () => {
    for (let i = 0; i < 205; i++) {
      useActivityStore.getState().log({ kind: 'fix', summary: `entry-${i}`, at: new Date(i).toISOString() });
    }
    const { entries } = useActivityStore.getState();
    expect(entries).toHaveLength(200);
    // Newest-first: entry-204 (the 205th, most recent) is at the front; the
    // oldest 5 (entry-0..entry-4) have fallen off the end.
    expect(entries[0]!.summary).toBe('entry-204');
    expect(entries[entries.length - 1]!.summary).toBe('entry-5');
  });

  it('clear() empties the log', () => {
    useActivityStore.getState().log({ kind: 'fix', summary: 'x', at: '2026-07-13T10:00:00.000Z' });
    useActivityStore.getState().clear();
    expect(useActivityStore.getState().entries).toEqual([]);
  });
});

describe('appliedPaths', () => {
  it('is empty when nothing has been logged', () => {
    expect(appliedPaths()).toEqual(new Set());
  });

  it('unions paths across every logged entry', () => {
    useActivityStore.getState().log({ kind: 'fix', summary: 'x', paths: ['a.ts', 'b.ts'], at: '2026-07-13T10:00:00.000Z' });
    useActivityStore
      .getState()
      .log({ kind: 'ignore-remove', summary: 'y', paths: ['b.ts', 'c.ts'], at: '2026-07-13T10:01:00.000Z' });
    expect(appliedPaths()).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
  });

  it('ignores entries that carry no paths at all (backward-compatible entry shape)', () => {
    useActivityStore.getState().log({ kind: 'sweep', summary: 'no paths here', at: '2026-07-13T10:00:00.000Z' });
    expect(appliedPaths()).toEqual(new Set());
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  it('renders "just now" for anything under a minute old', () => {
    expect(formatRelativeTime('2026-07-13T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime(now.toISOString(), now)).toBe('just now');
  });

  it('renders minutes for 1–59 minutes old', () => {
    expect(formatRelativeTime('2026-07-13T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-07-13T11:01:00.000Z', now)).toBe('59m ago');
  });

  it('renders hours for 1–23 hours old', () => {
    expect(formatRelativeTime('2026-07-13T09:00:00.000Z', now)).toBe('3h ago');
  });

  it('renders days for 1–6 days old', () => {
    expect(formatRelativeTime('2026-07-11T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to a locale date string beyond a week', () => {
    const result = formatRelativeTime('2026-06-01T12:00:00.000Z', now);
    expect(result).toBe(new Date('2026-06-01T12:00:00.000Z').toLocaleDateString());
  });
});
