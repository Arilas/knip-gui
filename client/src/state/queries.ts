// react-query wiring: server data (report, git status) as queries, api.ts
// calls as mutations, and a `useBusy` flag that's true while any
// scan/sweep/apply mutation is in flight OR the report is mid-scan. `useBusy`
// drives the sidebar's Re-run/workspace-switch controls and the sweep button
// (a UX affordance — the scan and sweep endpoints are ALSO latched server-side,
// so this is defense in depth, not the only guard).
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
// leave the server mid-scan or mid-write (scan itself, the sweep run, and
// fix/ignore apply, which trigger a background rescan).
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

// Shared by every mutation below that can rewrite source-file content (fix
// apply, ignore apply, ignore-remove apply, and sweep — an ignore/its removal
// both go through compileIgnorePlan, which for some issue types inserts/
// strips an `@public` JSDoc tag directly in the file rather than touching the
// knip config; a sweep is `knip --fix` across the whole project, just as
// capable of touching the currently-open file as a single apply). Invalidating
// the WHOLE `['file']` prefix rather than tracking "the currently-open file"
// specifically (Task 4, v0.3 UX backlog item) is the cheap-to-reason option
// the plan calls for: one extra cache-prefix invalidation, harmless even for
// files a mutation didn't touch (react-query only refetches ones with an
// active observer — see useFile), and it never needs updating if a future
// apply flow touches a file other than the one CodePane currently has open.
function invalidateFileQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ['file'] });
}

// Every mutation that rewrites the working tree (fix/ignore/ignore-remove apply,
// sweep) must refresh the report, the open file, AND git status — the last was
// missing, so GitFooter kept showing a clean tree / hid the "N uncommitted files"
// affordance after an apply until an unrelated refetch (window refocus) happened.
// `ignores: true` additionally refreshes the Ignored page/badge for config-writing
// applies. Called `onSettled` (not `onSuccess`): even a failed/partial apply can
// have written files and left the report mid-rescan, so the caches must refresh
// on failure too, matching the scan/sweep policy.
function invalidateAfterWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  opts: { ignores?: boolean } = {},
): void {
  queryClient.invalidateQueries({ queryKey: reportQueryKey });
  queryClient.invalidateQueries({ queryKey: gitStatusQueryKey });
  invalidateFileQueries(queryClient);
  if (opts.ignores) queryClient.invalidateQueries({ queryKey: ignoresQueryKey });
}

export function useScanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['scan'],
    mutationFn: (workspace?: string) => postScan(workspace),
    // Invalidate on settle (success OR failure), not just onSuccess (Task 6
    // browser-verification finding): POST /api/scan itself throws an ApiError
    // when the scan fails, but the server has ALREADY landed the fresh error
    // in the report store by then (src/server/index.ts's /api/scan catch sets
    // it before responding) — GET /api/report reflects it immediately.
    // onSuccess-only invalidation left nothing telling react-query's cache to
    // go get that fresh state, so a Re-run that itself fails (SetupScreen's
    // own primary action, or GitFooter's) just left the UI showing whatever
    // was cached before — stale 'ready' data with no visible sign the retry
    // failed, or a stale, no-longer-accurate error/stderr from a PREVIOUS
    // failed attempt once the user's fix changes what's wrong.
    onSettled: () => queryClient.invalidateQueries({ queryKey: reportQueryKey }),
  });
}

export function useSweepMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['sweep'],
    mutationFn: (opts: SweepOptions = {}) => postSweep(opts),
    // onSettled, not onSuccess-only (mirrors useScanMutation's Task 6 fix): a
    // sweep that itself fails must not leave the report query showing stale
    // cached data with no visible sign the sweep failed.
    onSettled: () => invalidateAfterWrite(queryClient),
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
    onSettled: () => invalidateAfterWrite(queryClient),
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
    // ignores:true also refreshes the Ignored page/AppSidebar badge, which never
    // unmounts and otherwise undercounts until the user visits it (Task 5 finding).
    onSettled: () => invalidateAfterWrite(queryClient, { ignores: true }),
  });
}

// Ignored page + AppSidebar badge (Task 5). Invalidated by BOTH config-file-
// mutating applies — useIgnoreApplyMutation (adds entries) and
// useIgnoreRemoveApplyMutation (removes them). Deliberately NOT invalidated
// by useFixApplyMutation or useSweepMutation: a fix/sweep (`knip --fix`)
// rewrites source files and package.json but never touches the knip config's
// ignore arrays, so there's nothing new for this query to see.
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
    onSettled: () => invalidateAfterWrite(queryClient, { ignores: true }),
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
