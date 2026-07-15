// Packages page (Task 4, UX overhaul): every dependency-shaped issue
// (PACKAGE_TYPES — dependencies/devDependencies/optionalPeerDependencies/
// binaries) grouped into one sortable shadcn Table per workspace (lib/
// filters.ts's groupByWorkspace), with a FilterChips toolbar + search above
// and a detail Sheet (workspace package.json, shiki-highlighted, scrolled to
// the dependency's line when findable) on row click. Replaces App.tsx's Task
// 1 TableView shim — see git history for the old flat, ungrouped table this
// supersedes.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '../../../../src/core/types.js';
import { filterIssues, groupByWorkspace, isActionable, PACKAGE_TYPES, typeLabel, type WorkspaceGroup } from '../../lib/filters.js';
import { highlightToHtml, langForPath } from '../../lib/highlighter.js';
import { idsToToggleForNode, nodeSelectionState } from '../../lib/tree.js';
import { useFile } from '../../state/queries.js';
import { useSelectionStore } from '../../state/selection.js';
import { useUiStore } from '../../state/ui.js';
import { SelectionDock } from '../SelectionDock.js';
import { FilterChips } from '../code/FilterChips.js';
import { TriStateCheckbox, TYPE_BADGE_LABELS, unactionableReason } from '../code/TreeNode.js';
import { Input } from '../ui/input.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export interface PackagesPageProps {
  issues: Issue[];
}

const ALL_PACKAGE_TYPES = new Set(PACKAGE_TYPES);

type SortKey = 'type' | 'symbol' | 'filePath';
type SortDir = 'asc' | 'desc';

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'filePath', label: 'File' },
];

function sortValue(issue: Issue, key: SortKey): string {
  if (key === 'type') return typeLabel(issue.type);
  if (key === 'symbol') return issue.symbol ?? '';
  return issue.filePath;
}

// Stable sort (native Array#sort) so re-sorting on an unchanged key never
// visibly reshuffles ties — same rationale as lib/dashboard.ts's sortRows.
function sortIssues(issues: Issue[], key: SortKey, dir: SortDir): Issue[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => sign * sortValue(a, key).localeCompare(sortValue(b, key)));
}

export function PackagesPage({ issues }: PackagesPageProps) {
  const packagesFilters = useUiStore((s) => s.packagesFilters);
  const togglePackagesFilter = useUiStore((s) => s.togglePackagesFilter);
  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [detailIssue, setDetailIssue] = useState<Issue | null>(null);

  // FilterChips' own live counts intentionally use the FULL package type set
  // (only search-scoped) so a chip shows "how many exist" even while it's
  // off — same pattern as TreeView.tsx's chipScopeIssues for the Code page.
  const chipScopeIssues = useMemo(() => filterIssues(issues, ALL_PACKAGE_TYPES, search), [issues, search]);
  const filtered = useMemo(() => filterIssues(issues, packagesFilters, search), [issues, packagesFilters, search]);
  const groups = useMemo(() => groupByWorkspace(filtered), [filtered]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? '↑' : '↓';
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Packages</h2>
          <Input
            type="search"
            placeholder="Filter by name or path…"
            aria-label="Filter packages by name or path"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-64"
            data-testid="packages-search"
          />
        </div>

        <div className="mb-3">
          <FilterChips issues={chipScopeIssues} enabled={packagesFilters} onToggle={togglePackagesFilter} types={PACKAGE_TYPES} />
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {issues.some((i) => ALL_PACKAGE_TYPES.has(i.type))
              ? 'No package issues match the current filters.'
              : 'No package issues found — knip is happy.'}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto" data-testid="packages-scroll">
            <div className="flex flex-col gap-6 pb-2">
              {groups.map((group) => (
                <WorkspaceTable
                  key={group.workspace}
                  group={group}
                  selected={selected}
                  onToggleIds={toggle}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                  sortIndicator={sortIndicator}
                  onRowClick={setDetailIssue}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <SelectionDock issues={issues} />

      <PackageDetailSheet
        issue={detailIssue}
        onOpenChange={(open) => {
          if (!open) setDetailIssue(null);
        }}
      />
    </div>
  );
}

function WorkspaceTable({
  group,
  selected,
  onToggleIds,
  sortKey,
  sortDir,
  onSort,
  sortIndicator,
  onRowClick,
}: {
  group: WorkspaceGroup;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  sortIndicator: (key: SortKey) => string;
  onRowClick: (issue: Issue) => void;
}) {
  const actionableIds = useMemo(() => group.issues.filter(isActionable).map((i) => i.id), [group.issues]);
  const headerState = nodeSelectionState({ actionableIds }, selected);
  const sortedIssues = useMemo(() => sortIssues(group.issues, sortKey, sortDir), [group.issues, sortKey, sortDir]);
  const label = group.workspace === '.' ? '(root)' : group.workspace;

  return (
    <section data-testid={`workspace-group-${group.workspace}`}>
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <TriStateCheckbox
                  state={headerState}
                  disabled={actionableIds.length === 0}
                  title={actionableIds.length === 0 ? 'No fixable or ignorable issues here' : 'Select all'}
                  ariaLabel={`Select all issues in ${label}`}
                  onChange={() => onToggleIds(idsToToggleForNode({ actionableIds }, selected))}
                />
              </TableHead>
              {SORT_COLUMNS.map(({ key, label: colLabel }) => (
                <TableHead key={key}>
                  <button
                    type="button"
                    className="flex items-center gap-1 font-medium"
                    onClick={() => onSort(key)}
                    data-testid={`packages-sort-${key}`}
                    aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {colLabel} {sortIndicator(key)}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedIssues.map((issue) => {
              const actionable = isActionable(issue);
              return (
                // Keyboard-operable row, same pattern as TreeNode.tsx's
                // TreeNodeRow: role="button" + tabIndex=0 + Enter/Space both
                // open the detail Sheet, so keyboard-only users can reach it
                // (a bare onClick on a <tr> is mouse-only). The checkbox cell
                // swallows click AND keydown (Space bubbles as keydown)
                // below, so checking a box never also opens the Sheet.
                <TableRow
                  key={issue.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${issue.filePath.split('/').pop() ?? 'package.json'} for ${issue.symbol ?? issue.filePath}`}
                  data-testid={`packages-row-${issue.type}-${issue.symbol ?? issue.id}`}
                  className="cursor-pointer outline-none focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onRowClick(issue)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick(issue);
                    }
                  }}
                >
                  <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(issue.id)}
                      disabled={!actionable}
                      title={actionable ? undefined : unactionableReason(issue)}
                      onChange={() => onToggleIds([issue.id])}
                      className="disabled:cursor-not-allowed"
                    />
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{TYPE_BADGE_LABELS[issue.type]}</span>
                      </TooltipTrigger>
                      <TooltipContent>{typeLabel(issue.type)}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="font-medium">{issue.symbol ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{issue.filePath}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// Human sentence explaining what the issue means, shown in the Sheet above
// the package.json content — typeLabel() alone ("Unused dependencies") reads
// fine as a stat-tile caption but is too terse standing alone in a detail
// view, so this spells out the specific dependency by name.
function explanationFor(issue: Issue): string {
  const name = issue.symbol ?? 'This entry';
  switch (issue.type) {
    case 'dependencies':
      return `"${name}" is listed in dependencies, but nothing in this workspace imports it.`;
    case 'devDependencies':
      return `"${name}" is listed in devDependencies, but nothing in this workspace imports it.`;
    case 'optionalPeerDependencies':
      return `"${name}" is an optional peer dependency that nothing in this workspace uses.`;
    case 'binaries':
      return `"${name}" is a declared binary/script that nothing in this workspace runs.`;
    default:
      return typeLabel(issue.type);
  }
}

function PackageDetailSheet({
  issue,
  onOpenChange,
}: {
  issue: Issue | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={issue !== null} onOpenChange={onOpenChange}>
      <SheetContent data-testid="package-detail-sheet" className="w-full gap-0 sm:max-w-xl">
        {issue && <PackageDetailContent issue={issue} />}
      </SheetContent>
    </Sheet>
  );
}

function PackageDetailContent({ issue }: { issue: Issue }) {
  const fileQuery = useFile(issue.filePath);
  const content = fileQuery.data?.content;
  const lang = langForPath(issue.filePath);

  const highlightQuery = useQuery({
    queryKey: ['highlight', issue.filePath, lang, content] as const,
    queryFn: async () => {
      if (!lang || content === undefined) throw new Error('highlight query ran without a language/content');
      return highlightToHtml(content, issue.filePath);
    },
    enabled: lang !== undefined && content !== undefined,
    retry: false,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  // Scrolls to (and highlights) the dependency's line once the highlighted
  // HTML is in the DOM. Dependency-shaped issues carry no line/col from knip
  // (see lib/highlighter.ts's issueLines doc comment — the same is true
  // here), so the only way to locate the right spot is a plain string search
  // over the RAW file content (not the tokenized HTML, where a naive search
  // would land mid-span) for a quoted reference to the dependency name; the
  // resulting line INDEX then maps 1:1 to the rendered `.line` spans, same
  // indexing CodePane.tsx's gutter-marker measurement relies on.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const html = highlightQuery.data;
    if (!container || !html || content === undefined || !issue.symbol) return;
    const targetLine = content.split('\n').findIndex((line) => line.includes(`"${issue.symbol}"`));
    if (targetLine === -1) return;
    const lineEls = container.querySelectorAll<HTMLElement>('.line');
    const target = lineEls[targetLine];
    if (!target) return;
    target.classList.add('code-pane-flagged-line');
    target.scrollIntoView({ block: 'center' });
  }, [content, highlightQuery.data, issue.symbol]);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{issue.symbol ?? issue.filePath}</SheetTitle>
        <SheetDescription>{explanationFor(issue)}</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <p className="mb-1.5 shrink-0 truncate font-mono text-xs text-muted-foreground" title={issue.filePath}>
          {issue.filePath}
        </p>
        {fileQuery.isLoading && <p className="text-sm text-muted-foreground">Loading {issue.filePath}…</p>}
        {fileQuery.error != null && <p className="text-sm text-destructive">Failed to load {issue.filePath}.</p>}
        {highlightQuery.data ? (
          <div
            ref={containerRef}
            data-testid="package-detail-code"
            className="code-pane-html min-h-0 flex-1 overflow-auto rounded border border-border"
            dangerouslySetInnerHTML={{ __html: highlightQuery.data }}
          />
        ) : (
          content !== undefined && (
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre rounded border border-border p-2 font-mono text-xs">
              {content}
            </pre>
          )
        )}
      </div>
    </>
  );
}
