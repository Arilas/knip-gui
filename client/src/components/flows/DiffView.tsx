// Per-file collapsible unified-diff block, originally built for
// ActionModal's preview step (Task 5): shiki-highlights the diff text itself
// (lang 'diff', via highlighter.ts's highlightDiff) rather than re-diffing/
// tokenizing the before/after source, since the server already rendered a
// unified diff string (src/fix/diff.ts's renderDiff) and shipped just that.
//
// ActionModal + CommitPanel were deleted in Task 3 (v0.3) — their preview
// step's diff rendering moved to the Review page (components/pages/
// ReviewPage.tsx), which reuses this component unchanged (still plain
// content, not a dialog itself) to show whichever single file the FileRail's
// selected row points at.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DiffEntry } from '../../lib/apply-flow.js';
import { highlightDiff } from '../../lib/highlighter.js';

export interface DiffViewProps {
  diff: DiffEntry;
  defaultOpen?: boolean;
}

export function DiffView({ diff, defaultOpen = true }: DiffViewProps) {
  const [open, setOpen] = useState(defaultOpen);

  const highlightQuery = useQuery({
    queryKey: ['diff-highlight', diff.filePath, diff.diff],
    queryFn: () => highlightDiff(diff.diff),
    enabled: open,
    retry: false,
  });

  return (
    <div
      className="overflow-hidden rounded border border-gray-200 dark:border-gray-800"
      data-testid={`diff-view-${diff.filePath}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-gray-50 px-3 py-1.5 text-left font-mono text-xs dark:bg-gray-900"
      >
        <span className="w-3 shrink-0 text-gray-500 dark:text-gray-400">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">{diff.filePath}</span>
      </button>

      {open && (
        <div className="diff-view-html border-t border-gray-200 dark:border-gray-800">
          {highlightQuery.isLoading && (
            <p className="p-2 text-xs text-gray-500 dark:text-gray-400">Highlighting…</p>
          )}
          {highlightQuery.error && (
            <pre className="overflow-x-auto whitespace-pre p-2 font-mono text-xs">{diff.diff}</pre>
          )}
          {highlightQuery.data && <div dangerouslySetInnerHTML={{ __html: highlightQuery.data }} />}
        </div>
      )}
    </div>
  );
}
