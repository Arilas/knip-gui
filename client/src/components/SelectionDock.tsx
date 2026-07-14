// Docked selection cart summary (Task 2, v0.3 — replaces SelectionBar.tsx):
// visible only once something's selected, rendered as an ordinary flex
// sibling AFTER a page's scrollable content (see CodePage.tsx/
// PackagesPage.tsx) rather than SelectionBar's `fixed inset-x-0 bottom-0`
// overlay — the content area shrinks to make room for this instead of the
// dock floating on top of the last row. Built entirely on shadcn
// primitives (Button/Badge/Popover) per the design spec's "shadcn tokens/
// components only" rule.
//
// onOpenModal is unchanged from SelectionBar: this task keeps Fix…/Ignore…
// opening the EXISTING ActionModal (App.tsx still owns `modalMode` state and
// passes this callback down through CodePage/PackagesPage) — the Review page
// (state/ui.ts's `startReview`) is Task 3's wiring; swapping this callback
// for a startReview() call is that task's one-line change, not this one's.
import { useMemo } from 'react';
import { XIcon } from 'lucide-react';
import type { Issue, IssueType } from '../../../src/core/types.js';
import { typeLabel } from '../lib/filters.js';
import { pluralizeType } from '../lib/pluralize.js';
import { useBusy } from '../state/queries.js';
import { useSelectionStore } from '../state/selection.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export interface SelectionDockProps {
  issues: Issue[];
  onOpenModal: (mode: 'fix' | 'ignore') => void;
}

function itemLabel(issue: Issue): string {
  return issue.symbol ? `${issue.filePath}: ${issue.symbol}` : issue.filePath;
}

export function SelectionDock({ issues, onOpenModal }: SelectionDockProps) {
  const selected = useSelectionStore((s) => s.selected);
  const clear = useSelectionStore((s) => s.clear);
  const toggle = useSelectionStore((s) => s.toggle);
  const busy = useBusy();

  const selectedIssues = useMemo(() => issues.filter((i) => selected.has(i.id)), [issues, selected]);

  // Per-type breakdown for the Badges row — same grouping selection.ts's
  // summaryByType does internally, computed separately here so each type
  // gets its own Badge element rather than one joined string.
  const typeCounts = useMemo(() => {
    const counts = new Map<IssueType, number>();
    for (const issue of selectedIssues) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [selectedIssues]);

  if (selected.size === 0) return null;

  return (
    <div
      data-testid="selection-dock"
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-2"
    >
      <span data-testid="selbar-count" className="text-sm font-semibold">
        {selected.size} selected
      </span>

      <div className="flex flex-wrap items-center gap-1">
        {typeCounts.map(([type, n]) => (
          <Badge key={type} variant="secondary" title={typeLabel(type)}>
            {pluralizeType(n, type)}
          </Badge>
        ))}
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" data-testid="selbar-items-trigger">
            {selected.size} item{selected.size === 1 ? '' : 's'} ▾
          </Button>
        </PopoverTrigger>
        <PopoverContent data-testid="selbar-items-popover" align="start" className="max-h-80 w-80 overflow-y-auto">
          <ul className="flex flex-col gap-1">
            {selectedIssues.map((issue) => (
              <li
                key={issue.id}
                data-testid={`selbar-item-${issue.id}`}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
              >
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {typeLabel(issue.type)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono" title={itemLabel(issue)}>
                  {itemLabel(issue)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${itemLabel(issue)} from selection`}
                  data-testid={`selbar-item-remove-${issue.id}`}
                  onClick={() => toggle([issue.id])}
                >
                  <XIcon className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => clear()} data-testid="selbar-clear">
          Clear
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onOpenModal('ignore')}
          data-testid="selbar-ignore"
        >
          Ignore
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onOpenModal('fix')} data-testid="selbar-fix">
          Fix…
        </Button>
      </div>
    </div>
  );
}
