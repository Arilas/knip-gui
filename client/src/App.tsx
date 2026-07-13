import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActionModal } from './components/ActionModal.js';
import { CodePane } from './components/CodePane.js';
import { FacetRail } from './components/FacetRail.js';
import { Overview } from './components/Overview.js';
import { SelectionBar } from './components/SelectionBar.js';
import { TableView } from './components/TableView.js';
import { ToastProvider } from './components/Toast.js';
import { TopBar } from './components/TopBar.js';
import { TreeView } from './components/TreeView.js';
import { issuesForFacet, type Facet } from './lib/facets.js';
import { useReport } from './state/queries.js';
import { useSelectionStore } from './state/selection.js';

// Facets with no per-symbol source position render as a sortable table
// instead of the file tree (see facets.ts's FILE_BEARING_TYPES doc comment).
const TABLE_FACETS = new Set<Facet>(['dependencies', 'unlisted', 'unresolved', 'binaries']);

const queryClient = new QueryClient();

function AppShell() {
  const [activeFacet, setActiveFacet] = useState<Facet>('overview');
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<'fix' | 'ignore' | null>(null);
  const { data, isLoading, error } = useReport();

  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);
  const pruneMissing = useSelectionStore((s) => s.pruneMissing);

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? ['.'];
  const facetIssues = issuesForFacet(activeFacet, issues);

  // Task 5's apply-flow obligation: whenever a fresh report lands (the
  // post-apply background rescan, a manual re-run, a sweep — any of them),
  // drop any selected/mode-overridden ids the new report no longer contains,
  // so the cart never shows a stale count for an issue that's already gone.
  // Keyed on scannedAt (not the `report` object reference, which changes on
  // every poll) so this only runs once per actual new scan.
  useEffect(() => {
    if (!report) return;
    pruneMissing(report.issues.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.scannedAt]);

  function onOpenModal(mode: 'fix' | 'ignore') {
    setModalMode(mode);
  }

  return (
    <div className="flex h-screen flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <FacetRail issues={issues} activeFacet={activeFacet} onSelectFacet={setActiveFacet} />
        <main className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 flex-col overflow-hidden pb-12">
            {isLoading && <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading report…</p>}
            {error && (
              <p className="p-4 text-sm text-red-600 dark:text-red-400">
                Failed to load the report: {error instanceof Error ? error.message : String(error)}
              </p>
            )}
            {!isLoading && !error && data?.status === 'error' && (
              <p className="p-4 text-sm text-red-600 dark:text-red-400">
                {data.error?.message ?? 'The last scan failed.'}
              </p>
            )}
            {!isLoading && !error && data?.status !== 'error' && activeFacet === 'overview' && (
              <Overview issues={issues} workspaces={workspaces} />
            )}
            {!isLoading && !error && data?.status !== 'error' && activeFacet !== 'overview' && TABLE_FACETS.has(activeFacet) && (
              <TableView issues={facetIssues} selected={selected} onToggleIds={toggle} />
            )}
            {!isLoading &&
              !error &&
              data?.status !== 'error' &&
              activeFacet !== 'overview' &&
              !TABLE_FACETS.has(activeFacet) && (
                <TreeView
                  issues={facetIssues}
                  selected={selected}
                  onToggleIds={toggle}
                  onOpenFile={setOpenFilePath}
                />
              )}
          </div>

          <aside className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-gray-200 dark:border-gray-800">
            {openFilePath && (
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-800">
                <span className="truncate font-mono text-xs" title={openFilePath}>
                  {openFilePath}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenFilePath(null)}
                  aria-label="Close file panel"
                  className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  ✕
                </button>
              </div>
            )}
            <CodePane
              filePath={openFilePath}
              issues={openFilePath ? issues.filter((i) => i.filePath === openFilePath) : []}
              selected={selected}
              onToggleIds={toggle}
            />
          </aside>
        </main>
      </div>

      <SelectionBar issues={issues} onOpenModal={onOpenModal} />

      {modalMode && <ActionModal mode={modalMode} issues={issues} onClose={() => setModalMode(null)} />}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </QueryClientProvider>
  );
}
