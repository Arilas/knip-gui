// Code page (Task 3, UX overhaul): rebuilt tree + filter chips on the left,
// resizable shadcn split, code pane on the right. Replaces the old inline
// TreeView/CodePane wiring that used to live directly in App.tsx.
//
// Layout persistence uses react-resizable-panels v4's `useDefaultLayout`
// hook (NOT the older `autoSaveId` string-prop API some docs/specs describe
// — this repo's installed version, 4.x, dropped that prop in favor of an
// explicit defaultLayout/onLayoutChanged pair backed by a storage object;
// see node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts).
// `id: 'knip-code-split'` is the persistence key (localStorage by default).
//
// The pane-collapse toggle lives in the TREE toolbar (TreeView), not inside
// the code pane's own header: once the right panel collapses to 0px width,
// anything rendered *inside* it (including a button meant to re-expand it)
// disappears too. `paneCollapsed` is tracked here via the Panel's onResize
// callback (fires on mount too, so a layout persisted as collapsed from a
// previous session is reflected immediately) and threaded down as a prop.
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import type { Issue } from '../../../../src/core/types.js';
import { CODE_TYPES, filterIssues } from '../../lib/filters.js';
import { useSelectionStore } from '../../state/selection.js';
import { useUiStore } from '../../state/ui.js';
import { SelectionDock } from '../SelectionDock.js';
import { CodePane } from '../code/CodePane.js';
import { TreeView } from '../code/TreeView.js';
import { Button } from '../ui/button.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';

export interface CodePageProps {
  issues: Issue[];
}

const ALL_CODE_TYPES = new Set(CODE_TYPES);

export function CodePage({ issues }: CodePageProps) {
  const codeFilters = useUiStore((s) => s.codeFilters);
  const toggleCodeFilter = useUiStore((s) => s.toggleCodeFilter);
  const codeSearch = useUiStore((s) => s.codeSearch);
  const setCodeSearch = useUiStore((s) => s.setCodeSearch);
  const openFile = useUiStore((s) => s.openFile);
  const openFileNonce = useUiStore((s) => s.openFileNonce);
  const navigate = useUiStore((s) => s.navigate);

  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);
  const addFileFiltered = useSelectionStore((s) => s.addFileFiltered);

  const codePanelRef = usePanelRef();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'knip-code-split' });
  const [paneCollapsed, setPaneCollapsed] = useState(false);

  // Every code-eligible issue (dependency-shaped types are Packages' concern
  // — Task 4); TreeView applies search+chip filtering itself, so this is
  // just the type-eligible slice.
  const codeIssues = useMemo(() => filterIssues(issues, ALL_CODE_TYPES, ''), [issues]);
  const openFileIssues = useMemo(
    () => (openFile ? issues.filter((i) => i.filePath === openFile) : []),
    [issues, openFile],
  );

  function onOpenFile(path: string) {
    navigate('code', { openFile: path });
    codePanelRef.current?.expand();
  }

  function closeFile() {
    navigate('code');
  }

  function toggleCodePanel() {
    const panel = codePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id="code-tree" defaultSize={35} minSize={20} className="flex min-h-0 flex-col">
          <TreeView
            issues={codeIssues}
            enabledTypes={codeFilters}
            onToggleFilter={toggleCodeFilter}
            search={codeSearch}
            onSearchChange={setCodeSearch}
            selected={selected}
            onToggleIds={toggle}
            onAddFileFiltered={addFileFiltered}
            onOpenFile={onOpenFile}
            paneCollapsed={paneCollapsed}
            onTogglePane={toggleCodePanel}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          id="code-pane"
          defaultSize={65}
          minSize={20}
          collapsible
          collapsedSize={0}
          panelRef={codePanelRef}
          onResize={(size) => setPaneCollapsed(size.inPixels === 0)}
          className="flex min-h-0 flex-col"
        >
          {openFile && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={openFile}>
                {openFile}
              </span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close file panel" onClick={closeFile}>
                <X className="size-4" />
              </Button>
            </div>
          )}
          <CodePane
            filePath={openFile ?? null}
            issues={openFileIssues}
            selected={selected}
            onToggleIds={toggle}
            openFileNonce={openFileNonce}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <SelectionDock issues={issues} />
    </div>
  );
}
