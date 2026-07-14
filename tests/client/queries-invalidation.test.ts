// Pins which queries each apply mutation invalidates on success (Task 5
// review finding, live-reproduced): an ignore apply writes ignore entries
// into the knip config — the file useIgnores reads — and AppSidebar's Ignored
// badge consumes that query and never unmounts, so useIgnoreApplyMutation
// MUST invalidate ignoresQueryKey alongside reportQueryKey (it originally
// only did the latter, leaving the badge stale until the user visited the
// Ignored page). Conversely a fix/sweep never touches the config's ignore
// arrays, so those mutations must NOT churn the ignores query.
//
// No @testing-library in this repo (client tests are pure-logic by Plan 3's
// constraints), so the hooks are rendered with a minimal react-dom harness:
// a throwaway component calls the hook under a QueryClientProvider whose
// QueryClient carries a spied invalidateQueries.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// queries.ts's api.js value-imports, mocked so no mutation ever touches
// fetch. Only the apply/scan/sweep functions get bodies with meaningful
// shapes; the rest just need to exist for the module to load.
vi.mock('../../client/src/api.js', () => ({
  getFile: vi.fn(),
  getGitStatus: vi.fn(),
  getIgnores: vi.fn(),
  getReport: vi.fn(),
  postFixApply: vi.fn(async () => ({ results: [], failedItems: [], rescanning: true })),
  postFixPreview: vi.fn(),
  postGitBranch: vi.fn(),
  postGitCommit: vi.fn(),
  postIgnoreApply: vi.fn(async () => ({ results: [], failedItems: [], rescanning: true })),
  postIgnorePreview: vi.fn(),
  postIgnoreRemoveApply: vi.fn(async () => ({ results: [], failedItems: [], rescanning: true })),
  postIgnoreRemovePreview: vi.fn(),
  postScan: vi.fn(),
  postSweep: vi.fn(async () => ({ issueCount: 0 })),
}));

import { postScan } from '../../client/src/api.js';
import {
  ignoresQueryKey,
  reportQueryKey,
  useFixApplyMutation,
  useIgnoreApplyMutation,
  useIgnoreRemoveApplyMutation,
  useScanMutation,
  useSweepMutation,
} from '../../client/src/state/queries.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

function renderHook<T>(useHook: () => T, queryClient: QueryClient): { current: T } {
  const result = { current: undefined as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    );
  });
  return result;
}

interface MutationLike {
  mutateAsync: (arg: never) => Promise<unknown>;
}

async function invalidatedKeysAfter(useHook: () => MutationLike, arg: unknown): Promise<unknown[]> {
  const queryClient = new QueryClient();
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  const result = renderHook(useHook, queryClient);
  await act(async () => {
    await result.current.mutateAsync(arg as never);
  });
  return spy.mock.calls.map(([filters]) => (filters as { queryKey?: unknown } | undefined)?.queryKey);
}

describe('apply-mutation query invalidation', () => {
  it('ignore apply invalidates BOTH the report and the ignores query (stale-badge regression pin)', async () => {
    const keys = await invalidatedKeysAfter(useIgnoreApplyMutation, 'plan-1');
    expect(keys).toContainEqual(reportQueryKey);
    expect(keys).toContainEqual(ignoresQueryKey);
  });

  it('ignore-remove apply invalidates BOTH the report and the ignores query', async () => {
    const keys = await invalidatedKeysAfter(useIgnoreRemoveApplyMutation, 'plan-1');
    expect(keys).toContainEqual(reportQueryKey);
    expect(keys).toContainEqual(ignoresQueryKey);
  });

  it('fix apply invalidates the report but NOT the ignores query (fixes never touch the config ignore arrays)', async () => {
    const keys = await invalidatedKeysAfter(useFixApplyMutation, 'plan-1');
    expect(keys).toContainEqual(reportQueryKey);
    expect(keys).not.toContainEqual(ignoresQueryKey);
  });

  it('sweep invalidates the report but NOT the ignores query (knip --fix never writes ignore entries)', async () => {
    const keys = await invalidatedKeysAfter(useSweepMutation, {});
    expect(keys).toContainEqual(reportQueryKey);
    expect(keys).not.toContainEqual(ignoresQueryKey);
  });

  // Task 4 (v0.3) UX backlog item: the code pane kept showing cached
  // pre-apply file content because nothing ever told react-query's cache
  // that an apply could have rewritten the currently-open file. Every
  // mutation that can rewrite source content (fix apply, ignore apply,
  // ignore-remove apply, sweep) must invalidate the `['file']` query-key
  // PREFIX — not just the exact `['file', <path>]` entry for whatever
  // happens to be open — so react-query's default prefix-matching
  // `invalidateQueries` catches it regardless of which file the apply
  // actually touched.
  it.each([
    ['fix apply', useFixApplyMutation, 'plan-1'],
    ['ignore apply', useIgnoreApplyMutation, 'plan-1'],
    ['ignore-remove apply', useIgnoreRemoveApplyMutation, 'plan-1'],
    ['sweep', useSweepMutation, {}],
  ] as const)('%s invalidates the file query prefix', async (_label, useHook, arg) => {
    const keys = await invalidatedKeysAfter(useHook, arg);
    expect(keys).toContainEqual(['file']);
  });

  it('scan invalidates the report on success', async () => {
    vi.mocked(postScan).mockResolvedValueOnce({ status: 'ready', issueCount: 0 });
    const keys = await invalidatedKeysAfter(useScanMutation, undefined);
    expect(keys).toContainEqual(reportQueryKey);
  });

  // Task 6 browser-verification finding: a scan that ITSELF fails (e.g.
  // Re-run from SetupScreen against a still-broken, or newly-broken, config)
  // must still invalidate the report query — the server has already landed
  // the fresh error in the store by the time POST /api/scan responds (and
  // throws), so without this the UI just keeps showing whatever was cached
  // before the failed retry, with no visible sign anything changed.
  it('scan invalidates the report on failure too, not just success', async () => {
    vi.mocked(postScan).mockRejectedValueOnce(new Error('scan failed'));
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const result = renderHook(useScanMutation, queryClient);
    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });
    const keys = spy.mock.calls.map(([filters]) => (filters as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(reportQueryKey);
  });

  // Task 7 polish item: useSweepMutation mirrored useScanMutation's Task 6
  // onSuccess-only bug — a failed sweep left the report query's stale cached
  // data on screen with no sign anything went wrong. Fixed to onSettled;
  // pinned the same way the scan-failure test above pins its fix.
  it('sweep invalidates the report on failure too, not just success', async () => {
    const { postSweep } = await import('../../client/src/api.js');
    vi.mocked(postSweep).mockRejectedValueOnce(new Error('sweep failed'));
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const result = renderHook(useSweepMutation, queryClient);
    await act(async () => {
      await result.current.mutateAsync({}).catch(() => {});
    });
    const keys = spy.mock.calls.map(([filters]) => (filters as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(reportQueryKey);
  });
});
