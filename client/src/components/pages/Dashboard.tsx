// Dashboard page (Task 2, UX overhaul): a stat-tile grid summarizing every
// issue type across the whole project, plus a sortable/searchable
// per-workspace breakdown table. Replaces the old flat Overview page (see
// Overview.tsx, deleted this task) — the sweep entry point ("Fix everything
// with knip --fix") moves from a standalone header button into this page's
// `⋯` menu (SweepDialog.tsx, extracted out of Overview.tsx).
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { getSweepCapabilities } from '../../api.js';
import { filterRows, sortRows, typeTotals, visibleColumns, workspaceRows, type SortKey } from '../../lib/dashboard.js';
import { useBusy, useReport, useSweepMutation } from '../../state/queries.js';
import { CODE_TYPES, PACKAGE_TYPES, useUiStore, type Page } from '../../state/ui.js';
import { SweepDialog } from '../flows/SweepDialog.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Input } from '../ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

// Icon + human label per issue type. nsExports/nsTypes/catalog/cycles have no
// dedicated Dashboard destination page (see lib/facets.ts's FILE_BEARING_TYPES
// doc comment — catalog/cycles carry no per-symbol source location at all,
// and nsExports/nsTypes fold into the exports/types facets everywhere else),
// so their tiles render but aren't clickable (pageForType returns undefined).
const TYPE_META: Record<IssueType, { label: string; icon: ComponentType<{ className?: string }> }> = {
  files: { label: 'Unused files', icon: FileX2 },
  exports: { label: 'Unused exports', icon: LogOut },
  nsExports: { label: 'Unused namespace exports', icon: LogOut },
  types: { label: 'Unused types', icon: Type },
  nsTypes: { label: 'Unused namespace types', icon: Type },
  enumMembers: { label: 'Unused enum members', icon: ListOrdered },
  namespaceMembers: { label: 'Unused namespace members', icon: Braces },
  duplicates: { label: 'Duplicate exports', icon: Copy },
  dependencies: { label: 'Unused dependencies', icon: Package },
  devDependencies: { label: 'Unused dev dependencies', icon: PackageMinus },
  optionalPeerDependencies: { label: 'Unused peer dependencies', icon: PackageSearch },
  unlisted: { label: 'Unlisted dependencies', icon: PackagePlus },
  unresolved: { label: 'Unresolved imports', icon: Unlink },
  binaries: { label: 'Unused binaries', icon: Binary },
  catalog: { label: 'Catalog entries', icon: HelpCircle },
  cycles: { label: 'Import cycles', icon: RefreshCw },
};

const CODE_TYPE_SET = new Set(CODE_TYPES);
const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);

// Dep-shaped types route to Packages, file-located types route to Code (see
// ui.ts's CODE_TYPES/PACKAGE_TYPES doc comments); catalog/cycles have no page
// of their own, so they route nowhere.
function pageForType(type: IssueType): Page | undefined {
  if (CODE_TYPE_SET.has(type)) return 'code';
  if (PACKAGE_TYPE_SET.has(type)) return 'packages';
  return undefined;
}

const ROW_HEIGHT = 36;
const VIRTUALIZE_THRESHOLD = 50;

export function Dashboard() {
  const { data } = useReport();
  const navigate = useUiStore((s) => s.navigate);
  const busy = useBusy();
  const sweepMutation = useSweepMutation();
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

  function onTileClick(type: IssueType) {
    const page = pageForType(type);
    if (!page) return;
    navigate(page, { filters: [type] });
  }

  // Cheap workspace scoping without a rescan: a workspace cell/row click sets
  // the type filter AND the Code page's tree path-prefix search to
  // `<workspace>/` (empty for the root workspace, '.', which has no
  // meaningful prefix) — see state/ui.ts's `codeSearch` doc comment. The real
  // rescanning workspace switcher stays in the sidebar.
  function searchPrefixFor(workspace: string): string {
    return workspace === '.' ? '' : `${workspace}/`;
  }

  function onCellClick(type: IssueType, workspace: string) {
    const page = pageForType(type);
    if (!page) return;
    navigate(page, { filters: [type], search: searchPrefixFor(workspace) });
  }

  function onRowOpen(workspace: string) {
    navigate('code', { search: searchPrefixFor(workspace) });
  }

  const parentRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualRows = shouldVirtualize ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index }));
  const totalSize = shouldVirtualize ? virtualizer.getTotalSize() : rows.length * ROW_HEIGHT;

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4">
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
              const meta = TYPE_META[type];
              const Icon = meta.icon;
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
                  <span className="text-xs text-muted-foreground">{meta.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Workspaces</h3>
            <Input
              type="search"
              placeholder="Search workspaces…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-64"
              data-testid="workspace-search"
            />
          </div>

          <div ref={parentRef} className="flex-1 overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>
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
                    <TableHead key={type} className="text-right">
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 font-medium"
                        onClick={() => onSort(type)}
                        data-testid={`sort-${type}`}
                        title={TYPE_META[type].label}
                      >
                        {type} {sortIndicator(type)}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">
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
              <TableBody style={{ position: 'relative', height: shouldVirtualize ? totalSize : undefined }}>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 2} className="text-center text-sm text-muted-foreground">
                      No workspaces match your search.
                    </TableCell>
                  </TableRow>
                ) : (
                  virtualRows.map((virtualRow) => {
                    const row = rows[virtualRow.index]!;
                    return (
                      <TableRow
                        key={row.workspace}
                        data-testid={`workspace-row-${row.workspace}`}
                        style={
                          shouldVirtualize
                            ? {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                height: ROW_HEIGHT,
                                transform: `translateY(${(virtualRow as { start?: number }).start ?? 0}px)`,
                              }
                            : undefined
                        }
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
                  })
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
          sweepMutation.mutate(opts, { onSuccess: () => setSweepOpen(false) });
        }}
      />
    </div>
  );
}
