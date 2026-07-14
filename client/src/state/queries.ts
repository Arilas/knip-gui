// react-query wiring: server data (report, git status) as queries, api.ts
// calls as mutations, and a `useBusy` flag that's true while any
// scan/sweep/apply mutation is in flight OR the report is mid-scan. This is
// the client-side serialization the sweep endpoint needs (it isn't
// self-latched server-side — see Plan 3's carried-over obligations) and is
// consumed by TopBar's Re-run/workspace-switch controls and Overview's sweep
// button.
import { useIsMutating, useMutation, useQuery, useQueryClient, type Mutation } from '@tanstack/react-query';
import type { IgnoreEntry } from '../../../src/ignore/config-writer.js';
import {
  getFile,
  getGitStatus,
  getIgnores,
  getReport,
  postFixApply,
  postFixPreview,
  postGitBranch,
  postGitCommit,
  postIgnoreApply,
  postIgnorePreview,
  postIgnoreRemoveApply,
  postIgnoreRemovePreview,
  postScan,
  postSweep,
  type FixSelection,
  type SweepOptions,
} from '../api.js';

export const reportQueryKey = ['report'] as const;
export const gitStatusQueryKey = ['git-status'] as const;
export const fileQueryKey = (path: string) => ['file', path] as const;
export const ignoresQueryKey = ['ignores'] as const;

// Mutation keys that participate in the busy flag — every mutation that can
// leave the server mid-scan or mid-write (scan itself, the unlatched sweep
// run, and fix/ignore apply, which trigger a background rescan).
const BUSY_MUTATION_KEYS = ['scan', 'sweep', 'fixApply', 'ignoreApply', 'ignoreRemoveApply'];

export function useReport() {
  return useQuery({
    queryKey: reportQueryKey,
    queryFn: getReport,
    // Poll every 2s while a scan is in flight so the UI picks up completion
    // without a manual refresh; stop polling once the report settles.
    refetchInterval: (query) => (query.state.data?.status === 'scanning' ? 2000 : false),
  });
}

export function useGitStatus() {
  return useQuery({ queryKey: gitStatusQueryKey, queryFn: getGitStatus });
}

// CodePane's file fetch (Task 4). `enabled: path !== null` means the query
// simply doesn't run for the "no file selected" empty state, rather than
// CodePane having to special-case a null path in its own render logic.
export function useFile(path: string | null) {
  return useQuery({
    queryKey: fileQueryKey(path ?? ''),
    queryFn: () => getFile(path as string),
    enabled: path !== null,
    retry: false,
  });
}

export function useScanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['scan'],
    mutationFn: (workspace?: string) => postScan(workspace),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportQueryKey }),
  });
}

export function useSweepMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['sweep'],
    mutationFn: (opts: SweepOptions = {}) => postSweep(opts),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportQueryKey }),
  });
}

export function useFixPreviewMutation() {
  return useMutation({
    mutationKey: ['fixPreview'],
    mutationFn: (selection: FixSelection) => postFixPreview(selection),
  });
}

export function useFixApplyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['fixApply'],
    mutationFn: (planId: string) => postFixApply(planId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportQueryKey }),
  });
}

export function useIgnorePreviewMutation() {
  return useMutation({
    mutationKey: ['ignorePreview'],
    mutationFn: (issueIds: string[]) => postIgnorePreview(issueIds),
  });
}

export function useIgnoreApplyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['ignoreApply'],
    mutationFn: (planId: string) => postIgnoreApply(planId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportQueryKey }),
  });
}

// Ignored page (Task 5). `useIgnores` invalidates alongside the report query
// (see useFixApplyMutation/useIgnoreApplyMutation/useIgnoreRemoveApplyMutation
// below and the rescan the background apply triggers) — but a rescan doesn't
// itself touch the config file the Ignored page reads, so IgnoredPage also
// refetches this query directly after a successful remove (see its
// onSuccess), same as it would after any other config-file-mutating action.
export function useIgnores() {
  return useQuery({ queryKey: ignoresQueryKey, queryFn: getIgnores });
}

export function useIgnoreRemovePreviewMutation() {
  return useMutation({
    mutationKey: ['ignoreRemovePreview'],
    mutationFn: (entries: IgnoreEntry[]) => postIgnoreRemovePreview(entries),
  });
}

export function useIgnoreRemoveApplyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['ignoreRemoveApply'],
    mutationFn: (planId: string) => postIgnoreRemoveApply(planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reportQueryKey });
      queryClient.invalidateQueries({ queryKey: ignoresQueryKey });
    },
  });
}

export function useGitBranchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['gitBranch'],
    mutationFn: (name: string) => postGitBranch(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: gitStatusQueryKey }),
  });
}

export function useGitCommitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['gitCommit'],
    mutationFn: ({ message, paths }: { message: string; paths: string[] }) => postGitCommit(message, paths),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: gitStatusQueryKey }),
  });
}

// True while a scan/sweep/apply mutation is in flight, or the last-known
// report is still 'scanning' (covers the fire-and-forget rescan the server
// kicks off after fix/ignore apply, which isn't itself one of our mutations).
export function useBusy(): boolean {
  const mutating = useIsMutating({
    predicate: (mutation: Mutation) => BUSY_MUTATION_KEYS.includes(String(mutation.options.mutationKey?.[0])),
  });
  const { data } = useReport();
  return mutating > 0 || data?.status === 'scanning';
}
