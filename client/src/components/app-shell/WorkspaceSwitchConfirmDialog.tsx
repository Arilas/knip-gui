// Shared discard-selection confirm for a workspace switch (Task P, #25): ONE
// AlertDialog definition consumed by both WorkspaceSwitcher (sidebar
// combobox) and CommandPalette (Workspaces group) — see
// hooks/use-workspace-switch.ts's doc comment for why each caller still owns
// its own pendingScope state while sharing this markup rather than each
// hand-rolling its own copy.
import { pluralizeWord } from '../../lib/pluralize.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js';

export interface WorkspaceSwitchConfirmDialogProps {
  /** useWorkspaceSwitch's `pendingScope` — non-null (and thus open) exactly
   *  while a switch is awaiting confirmation. */
  pendingScope: string | null;
  selectionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function WorkspaceSwitchConfirmDialog({
  pendingScope,
  selectionCount,
  onCancel,
  onConfirm,
}: WorkspaceSwitchConfirmDialogProps) {
  return (
    <AlertDialog open={pendingScope !== null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            You have {pluralizeWord(selectionCount, 'issue')} selected. Switching workspaces re-scans and clears any
            selection outside the new scope.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Keep selection</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Switch anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
