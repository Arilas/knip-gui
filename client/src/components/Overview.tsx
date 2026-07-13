// Overview facet: counts per issue type × workspace, plus the "Fix everything
// with knip --fix" sweep entry point (design spec's Overview bullet). Sweep
// isn't self-latched server-side, so the button — like TopBar's Re-run and
// workspace switch — stays disabled while useBusy() is true.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue, IssueType } from '../../../src/core/types.js';
import { getSweepCapabilities, type SweepCapabilities } from '../api.js';
import { facetCounts } from '../lib/facets.js';
import { useBusy, useSweepMutation } from '../state/queries.js';

// The subset of fix types the sweep dialog offers a checkbox for (brief:
// "exports, types, dependencies, duplicates"). knip's own --fix-type accepts
// more (files, enumMembers, ...) but these four are the ones worth letting a
// user opt out of individually before an unattended `knip --fix` run.
const SWEEP_FIX_TYPES = ['exports', 'types', 'dependencies', 'duplicates'] as const;

export interface OverviewProps {
  issues: Issue[];
  workspaces: string[];
}

interface SweepDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: { fixTypes?: string[]; allowRemoveFiles: boolean }) => void;
  capabilities?: SweepCapabilities;
  busy: boolean;
}

function SweepDialog({ open, onClose, onConfirm, capabilities, busy }: SweepDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [fixTypes, setFixTypes] = useState<string[]>([]);
  const [allowRemoveFiles, setAllowRemoveFiles] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!capabilities) return null;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="rounded-lg border border-gray-200 bg-white p-4 text-gray-900 shadow-lg backdrop:bg-black/30 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
    >
      <h2 className="text-sm font-semibold">Fix everything with knip --fix</h2>
      <p className="mt-1 max-w-sm text-xs text-gray-600 dark:text-gray-400">
        Runs knip's own <code>--fix</code> across the current scan scope, then re-scans.
      </p>

      {capabilities.fixType && (
        <fieldset className="mt-3 flex flex-col gap-1 text-sm">
          <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">Fix types</legend>
          {SWEEP_FIX_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fixTypes.includes(type)}
                onChange={(e) =>
                  setFixTypes((prev) => (e.target.checked ? [...prev, type] : prev.filter((t) => t !== type)))
                }
              />
              {type}
            </label>
          ))}
        </fieldset>
      )}

      {capabilities.allowRemoveFiles && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowRemoveFiles}
            onChange={(e) => setAllowRemoveFiles(e.target.checked)}
          />
          Allow removing unused files
        </label>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          disabled={busy}
          onClick={() => onConfirm({ fixTypes: fixTypes.length > 0 ? fixTypes : undefined, allowRemoveFiles })}
        >
          {busy ? 'Sweeping…' : 'Run sweep'}
        </button>
      </div>
    </dialog>
  );
}

export function Overview({ issues, workspaces }: OverviewProps) {
  const busy = useBusy();
  const sweepMutation = useSweepMutation();
  const { data: capabilities } = useQuery({
    queryKey: ['sweep-capabilities'],
    queryFn: getSweepCapabilities,
  });
  const [dialogOpen, setDialogOpen] = useState(false);

  const totalCounts = useMemo(() => facetCounts(issues), [issues]);
  const perWorkspaceCounts = useMemo(
    () => Object.fromEntries(workspaces.map((ws) => [ws, facetCounts(issues, ws)])),
    [issues, workspaces],
  );
  const allTypes = useMemo(
    () =>
      (Object.keys(totalCounts) as IssueType[]).sort(
        (a, b) => (totalCounts[b] ?? 0) - (totalCounts[a] ?? 0) || a.localeCompare(b),
      ),
    [totalCounts],
  );

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Overview</h2>
        <button
          type="button"
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          disabled={busy || !capabilities?.fix}
          title={!capabilities?.fix ? 'knip --fix is not available for this project' : undefined}
          onClick={() => setDialogOpen(true)}
        >
          Fix everything with knip --fix
        </button>
      </div>

      {allTypes.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">No issues found — knip is happy.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-gray-200 px-2 py-1 text-left dark:border-gray-800">Issue type</th>
                {workspaces.map((ws) => (
                  <th key={ws} className="border-b border-gray-200 px-2 py-1 text-right dark:border-gray-800">
                    {ws === '.' ? 'All workspaces' : ws}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allTypes.map((type) => (
                <tr key={type}>
                  <td className="border-b border-gray-100 px-2 py-1 dark:border-gray-900">{type}</td>
                  {workspaces.map((ws) => (
                    <td
                      key={ws}
                      className="border-b border-gray-100 px-2 py-1 text-right tabular-nums dark:border-gray-900"
                    >
                      {perWorkspaceCounts[ws]?.[type] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SweepDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        capabilities={capabilities}
        busy={busy || sweepMutation.isPending}
        onConfirm={(opts) => {
          sweepMutation.mutate(opts, { onSuccess: () => setDialogOpen(false) });
        }}
      />
    </div>
  );
}
