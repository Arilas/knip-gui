// Top-of-page chrome for the Review page (Task 3, v0.3): the frozen title/
// summary, plus the step-specific body that used to be spread across
// ActionModal's idle/previewing/previewed/failed steps. Per the design
// brief's "simplify" note, the fix-mode radios + delete-confirm (and the
// ignore explanation) only ever render in the pre-preview 'options' step —
// changing fix mode after compiling would require a re-preview, which this
// page doesn't offer (Cancel and re-select instead), so those controls are
// gone once a plan exists.
import type { ApplyFlowState } from '../../lib/apply-flow.js';
import type { FixMode, Issue } from '../../api.js';
import { optionsNextBlocked } from '../../lib/apply-flow.js';
import { Button } from '../ui/button.js';

export interface ReviewHeaderProps {
  kind: 'fix' | 'ignore';
  frozenCount: number;
  summary: string;
  flow: ApplyFlowState;
  affectedFiles: string[];
  exportTypeIssues: Issue[];
  currentExportTypeMode: FixMode;
  onSetExportTypeMode: (mode: FixMode) => void;
  deletePaths: string[];
  confirmDelete: boolean;
  onConfirmDeleteChange: (checked: boolean) => void;
  compileFailedLabels: string[];
  onPreview: () => void;
  onApply: () => void;
  onReset: () => void;
  onCancel: () => void;
}

const EXPORT_TYPE_MODES: { value: FixMode; label: string; hint: string }[] = [
  {
    value: 'strip-export',
    label: 'Stop exporting it',
    hint: 'Removes the export keyword only — the declaration stays in the file.',
  },
  {
    value: 'delete-declaration',
    label: 'Delete the declaration',
    hint: 'Removes the whole export/type declaration.',
  },
];

export function ReviewHeader({
  kind,
  frozenCount,
  summary,
  flow,
  affectedFiles,
  exportTypeIssues,
  currentExportTypeMode,
  onSetExportTypeMode,
  deletePaths,
  confirmDelete,
  onConfirmDeleteChange,
  compileFailedLabels,
  onPreview,
  onApply,
  onReset,
  onCancel,
}: ReviewHeaderProps) {
  const title = `${kind === 'fix' ? 'Fix' : 'Ignore'} ${frozenCount} issue${frozenCount === 1 ? '' : 's'}`;
  const cancelDisabled = flow.status === 'applying';
  const cancelLabel = flow.status === 'applied' ? 'Done' : 'Cancel';

  return (
    <div data-testid="review-header" className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{summary || 'unused code'}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cancelDisabled}
          onClick={onCancel}
          data-testid="review-cancel"
        >
          {cancelLabel}
        </Button>
      </div>

      {flow.status === 'idle' && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {affectedFiles.length} file{affectedFiles.length === 1 ? '' : 's'} affected: {affectedFiles.join(', ')}
          </p>

          {kind === 'fix' && exportTypeIssues.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-foreground">
                For the {exportTypeIssues.length} selected unused export{exportTypeIssues.length === 1 ? '' : 's'}/type
                {exportTypeIssues.length === 1 ? '' : 's'}:
              </legend>
              {EXPORT_TYPE_MODES.map((opt) => (
                <label key={opt.value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-type-mode"
                    className="mt-0.5"
                    checked={currentExportTypeMode === opt.value}
                    onChange={() => onSetExportTypeMode(opt.value)}
                  />
                  <span>
                    <span className="font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {kind === 'fix' && deletePaths.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {deletePaths.length} file{deletePaths.length === 1 ? '' : 's'} will be deleted:
              </p>
              <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-5 font-mono text-xs text-amber-900 dark:text-amber-100">
                {deletePaths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-100">
                <input
                  type="checkbox"
                  checked={confirmDelete}
                  onChange={(e) => onConfirmDeleteChange(e.target.checked)}
                />
                I understand these files will be permanently deleted.
              </label>
            </div>
          )}

          {kind === 'ignore' && (
            <p className="text-sm text-muted-foreground">
              This adds ignore entries to your knip config (for files/dependencies/binaries) or inserts an{' '}
              <code>@public</code> JSDoc tag directly in source (for exports/types/enum/namespace members) so knip
              stops flagging these. The exact file changed will be shown once you preview.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              disabled={optionsNextBlocked(kind, deletePaths, confirmDelete)}
              onClick={onPreview}
              data-testid="review-preview"
            >
              Preview changes
            </Button>
          </div>
        </div>
      )}

      {flow.status === 'previewing' && <p className="text-sm text-muted-foreground">Generating preview…</p>}

      {flow.status === 'previewed' && (
        <div className="flex flex-col gap-2">
          {compileFailedLabels.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              <p className="font-medium">Could not be compiled:</p>
              <ul className="mt-1 list-disc pl-5">
                {compileFailedLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onReset}>
              Back to options
            </Button>
            <Button
              type="button"
              disabled={flow.items.filter((i) => i.ok).length === 0}
              onClick={onApply}
              data-testid="review-apply"
            >
              Apply
            </Button>
          </div>
        </div>
      )}

      {flow.status === 'applying' && <p className="text-sm text-muted-foreground">Applying changes…</p>}

      {flow.status === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {flow.error}
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={onReset}>
              Back to options
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
