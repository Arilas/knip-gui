// Filter-chip toolbar, originally built for the Code page (Task 3, UX
// overhaul) and reused as-is by the Packages page (Task 4) via the `types`
// prop: one Badge-styled toggle per type (CODE_TYPES by default, PACKAGE_TYPES
// for Packages), all-on by default, live count computed from the current
// (search-scoped, NOT type-scoped — see the `issues` prop doc below) issue
// set, full label in a tooltip. Reflects/writes `ui.codeFilters` or
// `ui.packagesFilters` — the parent page owns the store wiring, this
// component is pure props in/callback out.
import { useMemo } from 'react';
import type { Issue, IssueType } from '../../../../src/core/types.js';
import { CODE_TYPES, typeLabel } from '../../lib/filters.js';
import { Badge } from '../ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';
import { TYPE_BADGE_LABELS } from './TreeNode.js';

export interface FilterChipsProps {
  /**
   * The issue set to compute live per-type counts from — callers pass
   * issues already scoped by search/workspace but BEFORE the type-enable
   * filter itself, so a chip's count reflects "how many would show up if
   * you turned this on" even while it's off.
   */
  issues: Issue[];
  enabled: ReadonlySet<IssueType>;
  onToggle: (type: IssueType) => void;
  /**
   * Which types get a chip, in display order — defaults to CODE_TYPES (the
   * Code page). Pure props-in/callback-out (Task 3's doc comment above), so
   * the Packages page (Task 4) reuses this unchanged by passing PACKAGE_TYPES.
   */
  types?: readonly IssueType[];
}

export function FilterChips({ issues, enabled, onToggle, types = CODE_TYPES }: FilterChipsProps) {
  const counts = useMemo(() => {
    const map = new Map<IssueType, number>();
    for (const issue of issues) map.set(issue.type, (map.get(issue.type) ?? 0) + 1);
    return map;
  }, [issues]);

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter tree by issue type">
      {types.map((type) => {
        const isOn = enabled.has(type);
        const count = counts.get(type) ?? 0;
        return (
          <Tooltip key={type}>
            <TooltipTrigger asChild>
              <Badge
                asChild
                variant={isOn ? 'default' : 'outline'}
                className="cursor-pointer select-none"
              >
                <button
                  type="button"
                  aria-pressed={isOn}
                  aria-label={`${typeLabel(type)}: ${count}${isOn ? '' : ' (hidden)'}`}
                  data-testid={`filter-chip-${type}`}
                  onClick={() => onToggle(type)}
                >
                  {TYPE_BADGE_LABELS[type]}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{typeLabel(type)}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
