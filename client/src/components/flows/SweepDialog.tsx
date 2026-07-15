// Sweep confirmation flow — "Fix everything with knip --fix" (Task 2, UX
// overhaul: extracted out of the old Overview.tsx, deleted this task, and
// rebuilt on shadcn's AlertDialog, which centers itself by default —
// `AlertDialogContent`'s `fixed top-1/2 left-1/2 -translate-x-1/2
// -translate-y-1/2`). Reachable from Dashboard's header `⋯` menu. The confirm/
// cancel actions stay disabled while `busy` is true (the sweep endpoint is also
// latched server-side; this is the UX-level guard).
import { useEffect, useState } from 'react';
import type { SweepCapabilities } from '../../api.js';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';

// The subset of fix types the sweep dialog offers a checkbox for (brief:
// "exports, types, dependencies, duplicates"). knip's own --fix-type accepts
// more (files, enumMembers, ...) but these four are the ones worth letting a
// user opt out of individually before an unattended `knip --fix` run.
const SWEEP_FIX_TYPES = ['exports', 'types', 'dependencies', 'duplicates'] as const;

export interface SweepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: { fixTypes?: string[]; allowRemoveFiles: boolean }) => void;
  capabilities?: SweepCapabilities;
  busy: boolean;
}

export function SweepDialog({ open, onOpenChange, onConfirm, capabilities, busy }: SweepDialogProps) {
  const [fixTypes, setFixTypes] = useState<string[]>([]);
  const [allowRemoveFiles, setAllowRemoveFiles] = useState(false);

  // The dialog stays mounted in Dashboard, so reset to defaults each time it
  // opens — otherwise a prior sweep's fix-type picks and (more consequentially)
  // its one-time "Allow removing unused files" consent silently carry into the
  // next, unrelated sweep.
  useEffect(() => {
    if (open) {
      setFixTypes([]);
      setAllowRemoveFiles(false);
    }
  }, [open]);

  if (!capabilities) return null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fix everything with knip --fix</AlertDialogTitle>
          <AlertDialogDescription>
            Runs knip's own <code>--fix</code> across the current scan scope, then re-scans.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {capabilities.fixType && (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Fix types (optional)</legend>
            <p className="mb-1 text-xs text-muted-foreground">
              Leave all unchecked to fix every issue type. Check specific types to limit the sweep
              to just those.
            </p>
            {SWEEP_FIX_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2">
                <Checkbox
                  checked={fixTypes.includes(type)}
                  onCheckedChange={(checked) =>
                    setFixTypes((prev) => (checked === true ? [...prev, type] : prev.filter((t) => t !== type)))
                  }
                />
                {type}
              </label>
            ))}
          </fieldset>
        )}

        {capabilities.allowRemoveFiles && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allowRemoveFiles}
              onCheckedChange={(checked) => setAllowRemoveFiles(checked === true)}
            />
            Allow removing unused files
          </label>
        )}

        <AlertDialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => onConfirm({ fixTypes: fixTypes.length > 0 ? fixTypes : undefined, allowRemoveFiles })}
          >
            {busy ? 'Sweeping…' : fixTypes.length > 0 ? `Fix ${fixTypes.length} selected` : 'Fix all types'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
