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

import {
  ignoresQueryKey,
  reportQueryKey,
  useFixApplyMutation,
  useIgnoreApplyMutation,
  useIgnoreRemoveApplyMutation,
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
});
