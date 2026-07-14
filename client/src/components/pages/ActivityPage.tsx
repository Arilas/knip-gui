// Activity page (Task 5, UX overhaul): a simple newest-first list of this
// session's fix/ignore/sweep/commit/ignore-remove outcomes, read straight off
// state/activity.ts's zustand store — no server round-trip, since the log
// itself is session-local (cleared on restart, which the page states
// explicitly per the design spec).
import type { ComponentType } from 'react';
import { EyeOff, GitCommit, History, Sparkles, Undo2, Wrench } from 'lucide-react';
import { formatRelativeTime } from '../../lib/activity.js';
import { useActivityStore, type ActivityKind } from '../../state/activity.js';

const KIND_ICONS: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  fix: Wrench,
  ignore: EyeOff,
  sweep: Sparkles,
  commit: GitCommit,
  'ignore-remove': Undo2,
};

const KIND_LABELS: Record<ActivityKind, string> = {
  fix: 'Fix',
  ignore: 'Ignore',
  sweep: 'Sweep',
  commit: 'Commit',
  'ignore-remove': 'Un-ignore',
};

export function ActivityPage() {
  const entries = useActivityStore((s) => s.entries);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
      <h2 className="mb-1 text-sm font-semibold">Activity</h2>
      <p className="mb-3 text-xs text-muted-foreground">Session only — clears on restart.</p>

      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <History className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing yet this session</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Fixes, ignores, sweeps, and commits you make will show up here as you go.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="activity-scroll">
          <ul className="flex flex-col gap-1 pb-2">
            {entries.map((entry) => {
              const Icon = KIND_ICONS[entry.kind];
              return (
                <li
                  key={entry.id}
                  data-testid={`activity-entry-${entry.id}`}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                    {KIND_LABELS[entry.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
                  {entry.sha && (
                    <code
                      className="shrink-0 font-mono text-xs text-muted-foreground"
                      data-testid={`activity-sha-${entry.id}`}
                    >
                      {entry.sha.slice(0, 7)}
                    </code>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground" title={entry.at}>
                    {formatRelativeTime(entry.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
