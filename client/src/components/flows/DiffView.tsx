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
import { Button } from '../ui/button.js';

export interface DiffViewProps {
  diff: DiffEntry;
  /**
   * Id of the compiled plan this diff belongs to (#34 item 1, DiffView
   * variant): the highlight query used to key on the FULL diff string,
   * paying a JSON.stringify of it on every render of the preview step. A
   * plan's diffs are immutable once compiled — every re-preview mints a
   * fresh planId (src/fix/plan.ts's newPlanId) — so planId+filePath
   * identifies the diff text exactly.
   */
  planId: string;
  defaultOpen?: boolean;
}

export function DiffView({ diff, planId, defaultOpen = true }: DiffViewProps) {
  const [open, setOpen] = useState(defaultOpen);

  const highlightQuery = useQuery({
    queryKey: ['diff-highlight', planId, diff.filePath],
    queryFn: () => highlightDiff(diff.diff),
    enabled: open,
    retry: false,
  });

  return (
    <div
      className="overflow-hidden rounded border border-border"
      data-testid={`diff-view-${diff.filePath}`}
    >
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="h-auto w-full justify-start gap-2 rounded-none bg-muted px-3 py-1.5 text-left font-mono text-xs"
      >
        <span className="w-3 shrink-0 text-muted-foreground">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">{diff.filePath}</span>
      </Button>

      {open && (
        <div className="diff-view-html border-t border-border">
          {highlightQuery.isLoading && (
            <p className="p-2 text-xs text-muted-foreground">Highlighting…</p>
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
