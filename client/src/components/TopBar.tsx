// Shared chrome (see docs/superpowers/specs/2026-07-13-knip-gui-design.md's
// "Top bar" bullet): project name, workspace picker that re-scans on change,
// Re-run (re-scans with the same scope), last-scan timestamp, git branch +
// dirty indicator. Re-run and the workspace picker are disabled while
// `useBusy()` is true — the client-side serialization the sweep endpoint
// needs since it isn't self-latched server-side (Plan 3 carried-over
// obligation).
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFile } from '../api.js';
import { useBusy, useGitStatus, useReport, useScanMutation } from '../state/queries.js';

// Best-effort project name from the root package.json's `name` field. Report
// itself carries no project-name field (see src/core/types.ts), so this is a
// second, independent query rather than something derived from useReport().
function useProjectName(): string {
  const { data } = useQuery({
    queryKey: ['file', 'package.json'],
    queryFn: () => getFile('package.json'),
    retry: false,
  });
  return useMemo(() => {
    if (!data) return 'knip-gui';
    try {
      const pkg = JSON.parse(data.content) as { name?: unknown };
      return typeof pkg.name === 'string' && pkg.name ? pkg.name : 'knip-gui';
    } catch {
      return 'knip-gui';
    }
  }, [data]);
}

export function TopBar() {
  const { data } = useReport();
  const { data: gitStatus } = useGitStatus();
  const scanMutation = useScanMutation();
  const busy = useBusy();
  const projectName = useProjectName();

  const report = data?.report;
  const workspaces = report?.workspaces ?? ['.'];
  const currentScope = report?.scope ?? '.';

  return (
    <header className="flex items-center gap-4 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-950">
      <h1 className="text-sm font-semibold">{projectName}</h1>

      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        <span className="sr-only">Workspace</span>
        <select
          className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          value={currentScope}
          disabled={busy}
          onChange={(e) => scanMutation.mutate(e.target.value)}
        >
          {workspaces.map((ws) => (
            <option key={ws} value={ws}>
              {ws === '.' ? 'All workspaces' : ws}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
        disabled={busy}
        onClick={() => scanMutation.mutate(currentScope)}
      >
        {busy ? 'Scanning…' : 'Re-run'}
      </button>

      {report?.scannedAt && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Scanned {new Date(report.scannedAt).toLocaleTimeString()}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        {gitStatus?.isRepo && (
          <>
            <span>{gitStatus.branch ?? '(detached HEAD)'}</span>
            <span
              className={`h-2 w-2 rounded-full ${gitStatus.dirty ? 'bg-amber-500' : 'bg-emerald-500'}`}
              title={gitStatus.dirty ? 'Working tree has uncommitted changes' : 'Working tree clean'}
            />
          </>
        )}
      </div>
    </header>
  );
}
