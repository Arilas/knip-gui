import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FacetRail } from './components/FacetRail.js';
import { Overview } from './components/Overview.js';
import { SelectionBar } from './components/SelectionBar.js';
import { TableView } from './components/TableView.js';
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
  // Task 4 (CodePane) drops in here — for now this just proves the wiring:
  // clicking a file row in the tree stashes its path and a placeholder panel
  // shows it.
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const { data, isLoading, error } = useReport();

  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? ['.'];
  const facetIssues = issuesForFacet(activeFacet, issues);

  // ActionModal is Task 5 — until then, this proves onOpenModal is wired
  // for real (SelectionBar's busy-disable logic already is) without
  // pretending a modal exists.
  function onOpenModal(mode: 'fix' | 'ignore') {
    console.info(`[knip-gui] ${mode} modal requested for ${selected.size} issue(s) — arrives in Task 5`);
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

          {openFilePath && (
            <aside className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-gray-200 dark:border-gray-800">
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
              <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-gray-500 dark:text-gray-400">
                Code pane for <span className="mx-1 font-mono">{openFilePath}</span> lands in Task 4.
              </div>
            </aside>
          )}
        </main>
      </div>

      <SelectionBar issues={issues} onOpenModal={onOpenModal} />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
