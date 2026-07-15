// Shared workspace-switch logic (Task P, #25): the select/confirm/runSwitch
// flow used to live solely in WorkspaceSwitcher.tsx (the sidebar combobox);
// the command palette's Workspaces group needs the EXACT same semantics —
// the discard-selection confirm and the busy/reviewing gate — rather than a
// second, independently-maintained copy that could silently drift, so it's
// extracted here and consumed by both call sites.
//
// Each call site gets its OWN pendingScope state (this is a plain hook, not
// a shared store) — harmless in practice, since a user only ever has one
// workspace-switch flow in progress at a time, and both call sites render
// the SAME WorkspaceSwitchConfirmDialog component (one AlertDialog
// definition, not two hand-written copies) bound to their own pendingScope.
import { useMemo, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { Issue } from '../../../src/core/types.js';
import { useBusy, useReport, useScanMutation } from '../state/queries.js';
import { useSelectionStore } from '../state/selection.js';
import { useUiStore } from '../state/ui.js';

// The scope value meaning "the whole project" — matches Report.scope's own
// convention (absent/'.' = unscoped).
export const ALL_WORKSPACES = '.';

interface WorkspaceEntry {
  value: string;
  label: string;
  count: number;
}

export interface UseWorkspaceSwitchResult {
  entries: WorkspaceEntry[];
  currentScope: string;
  /** Same gate as GitFooter's Re-run: a scoped rescan must not stack on
   *  another in-flight scan/sweep/apply or land while Review is open. */
  busy: boolean;
  reviewing: boolean;
  selectionCount: number;
  /** No-op on the already-current scope; prompts confirmSwitch/cancelSwitch
   *  when it would discard a non-empty selection; otherwise switches now. */
  select: (value: string) => void;
  /** Non-null while a switch to this scope awaits the discard-selection confirm. */
  pendingScope: string | null;
  confirmSwitch: () => void;
  cancelSwitch: () => void;
}

export function useWorkspaceSwitch(workspaces: string[], issues: Issue[]): UseWorkspaceSwitchResult {
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const { data } = useReport();
  const scanMutation = useScanMutation();
  const navigate = useNavigate();
  const busy = useBusy();
  const selectionCount = useSelectionStore((s) => s.selected.size);
  // Never let a scoped rescan land while the Review page is open — it prunes
  // the selection under a frozen "Fix N issues" title and can leave a
  // compiled plan pointing at a report that no longer matches.
  const reviewing = useRouterState({ select: (s) => s.location.pathname === '/review' });

  const currentScope = data?.report?.scope ?? ALL_WORKSPACES;

  const entries = useMemo<WorkspaceEntry[]>(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) counts.set(issue.workspace, (counts.get(issue.workspace) ?? 0) + 1);
    const rest = workspaces
      .filter((ws) => ws !== ALL_WORKSPACES)
      .sort((a, b) => a.localeCompare(b))
      .map((ws) => ({ value: ws, label: ws, count: counts.get(ws) ?? 0 }));
    return [{ value: ALL_WORKSPACES, label: 'All workspaces', count: issues.length }, ...rest];
  }, [workspaces, issues]);

  function runSwitch(value: string) {
    const ws = value === ALL_WORKSPACES ? undefined : value;
    // Mirror the new scope into the URL (All/'.' removes the param) so a
    // reload/bookmark restores it via the root's boot hydration. `replace`
    // (not push): `ws` is derived state mirrored to the URL, not a distinct
    // history stop — the root's reconcile effect keeps the two in sync one
    // way per phase (see router.tsx), so a pushed entry would only get
    // snapped back.
    navigate({ to: '.', search: (prev) => ({ ...prev, ws }), replace: true });
    // INVARIANT (Task W, #29 review): any SUCCESSFUL real scope switch clears
    // the Code page's scope chip, whoever initiated it — chip promote, sidebar
    // WorkspaceSwitcher, or CommandPalette. The chip is a client-side view
    // filter over the current report; once the report itself is re-scoped,
    // a leftover chip would silently filter the new report by the OLD
    // workspace (e.g. chip=packages/app + switch to packages/lib → an empty
    // tree behind a chip that lies). Cleared here, at the one choke point
    // every switch flows through, rather than via per-call-site callbacks —
    // a hook-instance seam only covered switches initiated by THAT instance.
    // getState() (not a subscription): this is a fire-time write, and the
    // hook must not re-render its consumers on unrelated codeScope changes.
    // onSuccess, not onSettled: a failed rescan never adopted the new scope,
    // so the chip is still accurate and should survive for a retry. Same-
    // scope rescans (GitFooter's Re-run, sweeps, fix/ignore applies) don't
    // go through runSwitch at all, so an innocent rescan keeps the chip.
    scanMutation.mutate(ws, { onSuccess: () => useUiStore.getState().setCodeScope(undefined) });
  }

  function select(value: string) {
    if (value === currentScope) return;
    // A scope change rescans, which prunes any selected issues outside the
    // new scope — warn before silently discarding a non-empty cart.
    if (selectionCount > 0) {
      setPendingScope(value);
      return;
    }
    runSwitch(value);
  }

  function confirmSwitch() {
    if (pendingScope !== null) runSwitch(pendingScope);
    setPendingScope(null);
  }

  function cancelSwitch() {
    setPendingScope(null);
  }

  return { entries, currentScope, busy, reviewing, selectionCount, select, pendingScope, confirmSwitch, cancelSwitch };
}
