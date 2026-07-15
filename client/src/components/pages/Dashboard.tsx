// Dashboard page (Task 2, UX overhaul): a stat-tile grid summarizing every
// issue type across the whole project, plus a sortable/searchable
// per-workspace breakdown table. Replaces the old flat Overview page (see
// Overview.tsx, deleted this task) — the sweep entry point ("Fix everything
// with knip --fix") moves from a standalone header button into this page's
// `⋯` menu (SweepDialog.tsx, extracted out of Overview.tsx).
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Binary,
  Braces,
  Copy,
  FileX2,
  HelpCircle,
  ListOrdered,
  LogOut,
  MoreHorizontal,
  Package,
  PackageMinus,
  PackagePlus,
  PackageSearch,
  RefreshCw,
  Type,
  Unlink,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { IssueType } from '../../../../src/core/types.js';
import { toast } from 'sonner';
import { apiErrorMessage, getSweepCapabilities } from '../../api.js';
import { filterRows, sortRows, typeTotals, visibleColumns, workspaceRows, type SortKey } from '../../lib/dashboard.js';
import { CODE_TYPES, PACKAGE_TYPES, typeLabel } from '../../lib/filters.js';
import { useActivityStore } from '../../state/activity.js';
import { useBusy, useReport, useSweepMutation } from '../../state/queries.js';
import { useUiStore } from '../../state/ui.js';
import { SweepDialog } from '../flows/SweepDialog.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Input } from '../ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

// Icon per issue type (labels come from lib/filters.ts's typeLabel, the one
// shared source of human names — Task 3). nsExports/nsTypes/catalog/cycles
// have no dedicated Dashboard destination page (see lib/filters.ts's
// CODE_TYPES/PACKAGE_TYPES doc comments — catalog/cycles carry no per-symbol
// source location at all, and nsExports/nsTypes fold into the exports/types
// filter chips everywhere else), so their tiles render but aren't clickable
// (pageForType returns undefined).
const TYPE_ICONS: Record<IssueType, ComponentType<{ className?: string }>> = {
  files: FileX2,
  exports: LogOut,
  nsExports: LogOut,
  types: Type,
  nsTypes: Type,
  enumMembers: ListOrdered,
  namespaceMembers: Braces,
  duplicates: Copy,
  dependencies: Package,
  devDependencies: PackageMinus,
  optionalPeerDependencies: PackageSearch,
  unlisted: PackagePlus,
  unresolved: Unlink,
  binaries: Binary,
  catalog: HelpCircle,
  cycles: RefreshCw,
};

const CODE_TYPE_SET = new Set(CODE_TYPES);
const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);

// Dep-shaped types route to Packages, file-located types route to Code (see
// lib/filters.ts's CODE_TYPES/PACKAGE_TYPES doc comments); catalog/cycles have
// no page of their own, so they route nowhere. Returns the router path.
type RoutePath = '/code' | '/packages';
function pageForType(type: IssueType): RoutePath | undefined {
  if (CODE_TYPE_SET.has(type)) return '/code';
  if (PACKAGE_TYPE_SET.has(type)) return '/packages';
  return undefined;
}

const ROW_HEIGHT = 36;
const VIRTUALIZE_THRESHOLD = 50;

export function Dashboard() {
  const { data } = useReport();
  const navigate = useNavigate();
  const setCodeFilters = useUiStore((s) => s.setCodeFilters);
  const setPackagesFilters = useUiStore((s) => s.setPackagesFilters);
  const setCodeScope = useUiStore((s) => s.setCodeScope);
  const busy = useBusy();
  const sweepMutation = useSweepMutation();
  const log = useActivityStore((s) => s.log);
  const { data: capabilities } = useQuery({
    queryKey: ['sweep-capabilities'],
    queryFn: getSweepCapabilities,
  });
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');

  const issues = data?.report?.issues ?? [];

  const totals = useMemo(() => typeTotals(issues), [issues]);
  const allRows = useMemo(() => workspaceRows(issues), [issues]);
  const columns = useMemo(() => visibleColumns(allRows), [allRows]);
  const rows = useMemo(
    () => sortRows(filterRows(allRows, search), sortKey, sortDir),
    [allRows, search, sortKey, sortDir],
  );

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? '↑' : '↓';
  }

  // Screen-reader sort state on the column header (matches PackagesPage's table).
  function ariaSort(key: SortKey): 'ascending' | 'descending' | undefined {
    if (key !== sortKey) return undefined;
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  // Replace the target page's chip set (the old navigate's replace-when-given
  // semantics) THEN route to it. Navigating to /code with no `file` search drops
  // any open file, matching the old navigate clearing openFile; `ws` rides along
  // via the root's retainSearchParams. Filters are set on the store, not the
  // URL, so they apply to the destination page regardless of the current one.
  function onTileClick(type: IssueType) {
    const to = pageForType(type);
    if (!to) return;
    if (to === '/code') setCodeFilters([type]);
    else setPackagesFilters([type]);
    navigate({ to });
  }

  // Cheap workspace scoping without a rescan: a workspace cell/row click sets
  // the Code page's scope CHIP (state/ui.ts's `codeScope`) to the workspace,
  // rather than the old #29-reported behavior of stuffing a path prefix into
  // the free-text search box — that conflated "narrow the view" with "type a
  // search", and made typing impossible once a click had pre-filled the box.
  // setCodeScope itself normalizes root ('.') to "no chip", so this needs no
  // special-casing here. The real rescanning workspace switcher stays in the
  // sidebar; the Code page's chip offers a one-click promote to it.
  function onCellClick(type: IssueType, workspace: string) {
    const to = pageForType(type);
    if (!to) return;
    // Only the Code page reads codeScope (PackagesPage has its own local search
    // state) — setting it for a packages-page cell would just silently pollute
    // the Code tree's scope for a later, unrelated visit.
    if (to === '/code') {
      setCodeFilters([type]);
      setCodeScope(workspace);
    } else {
      setPackagesFilters([type]);
    }
    navigate({ to });
  }

  function onRowOpen(workspace: string) {
    setCodeScope(workspace);
    navigate({ to: '/code' });
  }

  const parentRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });
  // Virtualization uses spacer <tr>s above/below the rendered window rather
  // than absolutely-positioned rows: position:absolute pulls a <tr> out of
  // table layout entirely (its cells stop aligning with the header's
  // columns), while spacer rows keep real table semantics and alignment.
  const virtualItems = virtualizer.getVirtualItems();
  const renderedIndices = shouldVirtualize ? virtualItems.map((v) => v.index) : rows.map((_, index) => index);
  const padTop = shouldVirtualize && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const padBottom =
    shouldVirtualize && virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Dashboard</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Dashboard actions" data-testid="dashboard-menu-trigger">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="dashboard-sweep-item"
              disabled={busy || !capabilities?.fix}
              onSelect={() => setSweepOpen(true)}
            >
              Fix everything with knip --fix
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {totals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No issues found — knip is happy.</p>
      ) : (
        <>
          <div
            className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            data-testid="stat-tiles"
          >
            {totals.map(({ type, count }) => {
              const Icon = TYPE_ICONS[type];
              const clickable = pageForType(type) !== undefined;
              return (
                <button
                  key={type}
                  type="button"
                  data-testid={`stat-tile-${type}`}
                  disabled={!clickable}
                  onClick={() => onTileClick(type)}
                  className="flex flex-col items-start gap-1 rounded-lg border border-border p-3 text-left transition-colors enabled:hover:bg-muted disabled:cursor-default"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-lg font-semibold tabular-nums">{count}</span>
                  <span className="text-xs text-muted-foreground">{typeLabel(type)}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Workspaces</h3>
            <Input
              type="search"
              placeholder="Search workspaces…"
              aria-label="Search workspaces"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-64"
              data-testid="workspace-search"
            />
          </div>

          {/*
            This div is the ONLY scroll container for the table (both axes) —
            required for the sticky header and the virtualizer, which both
            need a single bounded scrollport. shadcn's Table wraps the <table>
            in its own overflow-x-auto div (data-slot="table-container"); left
            alone, that wrapper becomes the sticky header's nearest scrollport
            (a scroll container on either axis captures sticky on both), and
            since the wrapper grows with the table the header would never pin.
            The arbitrary variant neutralizes it to overflow-visible so
            stickiness resolves against this div instead — done from out here
            via a variant, not by editing the ui/table.tsx registry file.
          */}
          <div
            ref={parentRef}
            data-testid="workspace-table-scroll"
            className="min-h-0 flex-1 overflow-auto rounded-md border border-border [&_[data-slot=table-container]]:overflow-visible"
          >
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead aria-sort={ariaSort('workspace')}>
                    <button
                      type="button"
                      className="flex items-center gap-1 font-medium"
                      onClick={() => onSort('workspace')}
                      data-testid="sort-workspace"
                    >
                      Workspace {sortIndicator('workspace')}
                    </button>
                  </TableHead>
                  {columns.map((type) => (
                    <TableHead key={type} className="text-right" aria-sort={ariaSort(type)}>
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 font-medium"
                        onClick={() => onSort(type)}
                        data-testid={`sort-${type}`}
                        title={typeLabel(type)}
                      >
                        {type} {sortIndicator(type)}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="text-right" aria-sort={ariaSort('total')}>
                    <button
                      type="button"
                      className="ml-auto flex items-center gap-1 font-medium"
                      onClick={() => onSort('total')}
                      data-testid="sort-total"
                    >
                      Total {sortIndicator('total')}
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 2} className="text-center text-sm text-muted-foreground">
                      No workspaces match your search.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {padTop > 0 && (
                      <tr aria-hidden style={{ height: padTop }}>
                        <td colSpan={columns.length + 2} />
                      </tr>
                    )}
                    {renderedIndices.map((index) => {
                      const row = rows[index]!;
                      return (
                        <TableRow
                          key={row.workspace}
                          data-testid={`workspace-row-${row.workspace}`}
                          style={shouldVirtualize ? { height: ROW_HEIGHT } : undefined}
                        >
                          <TableCell className="font-medium">
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() => onRowOpen(row.workspace)}
                              data-testid={`workspace-open-${row.workspace}`}
                            >
                              {row.workspace === '.' ? '(root)' : row.workspace}
                            </button>
                          </TableCell>
                          {columns.map((type) => (
                            <TableCell
                              key={type}
                              className="text-right tabular-nums"
                              data-testid={`cell-${row.workspace}-${type}`}
                            >
                              {row.counts[type] ? (
                                <button
                                  type="button"
                                  className="hover:underline disabled:no-underline"
                                  disabled={pageForType(type) === undefined}
                                  onClick={() => onCellClick(type, row.workspace)}
                                >
                                  {row.counts[type]}
                                </button>
                              ) : (
                                <span className="text-muted-foreground">–</span>
                              )}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-medium tabular-nums">{row.total}</TableCell>
                        </TableRow>
                      );
                    })}
                    {padBottom > 0 && (
                      <tr aria-hidden style={{ height: padBottom }}>
                        <td colSpan={columns.length + 2} />
                      </tr>
                    )}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <SweepDialog
        open={sweepOpen}
        onOpenChange={setSweepOpen}
        capabilities={capabilities}
        busy={busy || sweepMutation.isPending}
        onConfirm={(opts) => {
          sweepMutation.mutate(opts, {
            onSuccess: (result) => {
              setSweepOpen(false);
              log({
                kind: 'sweep',
                summary: `knip --fix — ${result.issueCount} issue${result.issueCount === 1 ? '' : 's'} remaining`,
                at: new Date().toISOString(),
              });
            },
            // A failed sweep was previously silent — no toast, dialog just
            // un-busied. Surface the error and keep the dialog open to retry.
            onError: (e) => toast.error(apiErrorMessage(e)),
          });
        }}
      />
    </div>
  );
}
