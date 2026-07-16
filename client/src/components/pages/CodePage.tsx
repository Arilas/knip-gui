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
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import type { Issue } from '../../../../src/core/types.js';
import { ALL_WORKSPACES, useWorkspaceSwitch } from '../../hooks/use-workspace-switch.js';
import { CODE_TYPES, filterIssues } from '../../lib/filters.js';
import { useReport } from '../../state/queries.js';
import { useSelectionStore } from '../../state/selection.js';
import { useUiStore } from '../../state/ui.js';
import { WorkspaceSwitchConfirmDialog } from '../app-shell/WorkspaceSwitchConfirmDialog.js';
import { SelectionDock } from '../SelectionDock.js';
import { CodePane } from '../code/CodePane.js';
import { TreeView } from '../code/TreeView.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';

export interface CodePageProps {
  issues: Issue[];
  /** The open file — `/code`'s `file` search param, threaded in by the route (router.tsx). */
  file?: string;
}

const ALL_CODE_TYPES = new Set(CODE_TYPES);

export function CodePage({ issues, file }: CodePageProps) {
  const codeFilters = useUiStore((s) => s.codeFilters);
  const toggleCodeFilter = useUiStore((s) => s.toggleCodeFilter);
  const codeSearch = useUiStore((s) => s.codeSearch);
  const setCodeSearch = useUiStore((s) => s.setCodeSearch);
  const codeScope = useUiStore((s) => s.codeScope);
  const setCodeScope = useUiStore((s) => s.setCodeScope);
  const openFileNonce = useUiStore((s) => s.openFileNonce);
  const bumpOpenFileNonce = useUiStore((s) => s.bumpOpenFileNonce);
  const navigate = useNavigate();
  const openFile = file;

  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);
  const addFileFiltered = useSelectionStore((s) => s.addFileFiltered);

  // The chip's "Scan only this workspace" promote button (Task W, #29) hands
  // off to the SAME select/confirm/runSwitch flow the sidebar switcher and
  // command palette use — see hooks/use-workspace-switch.ts's doc comment for
  // why each call site owns its own pendingScope while sharing that flow
  // (and WorkspaceSwitchConfirmDialog's markup) rather than duplicating it.
  // `workspaces` mirrors the pattern router.tsx/CommandPalette already use to
  // feed this hook; the chip itself never renders the picker list, only calls
  // `.select(scope)` directly, so entries/currentScope beyond `currentScope`
  // (below) are unused here but harmless to compute. The chip clearing itself
  // after a successful promote needs no wiring here: runSwitch's success path
  // clears codeScope for EVERY real scope switch, whoever initiated it (see
  // use-workspace-switch.ts's invariant comment).
  const { data } = useReport();
  const workspaces = data?.report?.workspaces ?? [ALL_WORKSPACES];
  const workspaceSwitch = useWorkspaceSwitch(workspaces, issues);
  // Hidden once the real scan scope already matches the chip — promoting an
  // already-scoped view would be a same-scope no-op (select() also guards
  // this, but hiding avoids showing a dead-looking enabled button).
  const canPromote = codeScope !== undefined && workspaceSwitch.currentScope !== codeScope;

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

  // useCallback (#35): threaded through TreeView into every memo'd
  // TreeNodeRow (and TreeView's own Enter-key handler) — a fresh closure per
  // CodePage render would defeat the row memo. All three deps are stable:
  // bumpOpenFileNonce is a zustand action, navigate is TanStack Router's
  // stable navigate function, codePanelRef is a ref object.
  const onOpenFile = useCallback(
    (path: string) => {
      // Bump the nonce on EVERY explicit open, even re-clicking the already-open
      // row: the router won't re-render on a navigation to an identical URL, so
      // the nonce (a store write) is what re-fires CodePane's scroll/pulse. `ws`
      // rides along via retainSearchParams; other search params are untouched.
      bumpOpenFileNonce();
      navigate({ to: '/code', search: (prev) => ({ ...prev, file: path }) });
      codePanelRef.current?.expand();
    },
    [bumpOpenFileNonce, navigate, codePanelRef],
  );

  function closeFile() {
    navigate({ to: '/code', search: (prev) => ({ ...prev, file: undefined }) });
  }

  function toggleCodePanel() {
    const panel = codePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        The workspace scope chip (Task W, #29): a page-level bar, not part of
        TreeView's own toolbar, because clearing/promoting it needs the report
        (for currentScope/workspaces) and the shared workspace-switch flow —
        concerns TreeView deliberately doesn't have (it stays pure props-in/
        callback-out). Only rendered once a Dashboard cell/row click (or a
        promote-pending confirm) has actually set codeScope; root ('.') never
        reaches here since setCodeScope normalizes it away.
      */}
      {codeScope && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
          data-testid="scope-chip"
        >
          <span className="text-xs text-muted-foreground">Scoped to</span>
          <Badge variant="secondary" className="max-w-full gap-1 pr-1">
            <span className="truncate font-mono">{codeScope}</span>
            <button
              type="button"
              aria-label={`Clear ${codeScope} scope`}
              data-testid="scope-chip-clear"
              className="rounded-full p-0.5 hover:bg-muted-foreground/20"
              onClick={() => setCodeScope(undefined)}
            >
              <X className="size-3" />
            </button>
          </Badge>
          {canPromote && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="scope-chip-promote"
              disabled={workspaceSwitch.busy || workspaceSwitch.reviewing}
              title={workspaceSwitch.reviewing ? 'Finish or cancel the review first' : undefined}
              onClick={() => workspaceSwitch.select(codeScope)}
            >
              Scan only this workspace
            </Button>
          )}
        </div>
      )}
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
            scope={codeScope}
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

      {/* Shared discard-selection confirm for the chip's promote button — same
          dialog WorkspaceSwitcher/CommandPalette render, bound to THIS page's
          own pendingScope (see use-workspace-switch.ts's doc comment for why
          every call site owns its own pendingScope while sharing this one
          AlertDialog definition). */}
      <WorkspaceSwitchConfirmDialog
        pendingScope={workspaceSwitch.pendingScope}
        selectionCount={workspaceSwitch.selectionCount}
        onCancel={workspaceSwitch.cancelSwitch}
        onConfirm={workspaceSwitch.confirmSwitch}
      />
    </div>
  );
}
