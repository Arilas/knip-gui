// Row renderers for TreeView's flattened, virtualized list (Task 3 rebuild,
// UX overhaul): one component per row kind (dir / file — no more per-issue
// child rows; per-symbol selection now happens via the code pane's gutter
// badges once a file is open, since a file row's whole click now opens it
// rather than expanding). Compact (h-7) rows, lucide folder/file icons, a
// chevron only on directories, and a single Tooltip-backed muted count on
// directory rows (per-type badges stay on file rows). Kept separate from
// TreeView.tsx so the virtualization/expand-state plumbing there stays
// readable.
import type { ComponentType } from 'react';
import { useEffect, useRef } from 'react';
import { File, FileCode2, FileJson, FileText, Folder, FolderOpen } from 'lucide-react';
import type { Issue, IssueType } from '../../../../src/core/types.js';
import { isFixable, isIgnorable, typeLabel } from '../../lib/filters.js';
import {
  collectFileIssues,
  idsToToggleForNode,
  nodeSelectionState,
  scopedActionableIds,
  type DirNode,
  type FileNode,
} from '../../lib/tree.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export type FlatRow =
  | { kind: 'dir'; node: DirNode; depth: number; expanded: boolean }
  | { kind: 'file'; node: FileNode; depth: number };

export interface TreeNodeRowProps {
  row: FlatRow;
  selected: ReadonlySet<string>;
  enabledTypes: ReadonlySet<IssueType>;
  onToggleExpand: (path: string) => void;
  onToggleIds: (ids: string[]) => void;
  onAddFileFiltered: (fileIssues: Issue[], enabled: ReadonlySet<IssueType>) => void;
  onOpenFile: (path: string) => void;
}

// Compact per-type pill labels — the badges are small, so these are
// abbreviations rather than lib/filters.ts's full typeLabel() text (used
// instead for tooltips, where space isn't as tight). Exported for CodePane's
// gutter-marker badges and FilterChips' chip labels, which want the same
// abbreviations rather than a second, possibly-drifting copy.
export const TYPE_BADGE_LABELS: Record<IssueType, string> = {
  files: 'files',
  exports: 'export',
  nsExports: 'ns export',
  types: 'type',
  nsTypes: 'ns type',
  enumMembers: 'enum member',
  namespaceMembers: 'ns member',
  duplicates: 'duplicate',
  dependencies: 'dependency',
  devDependencies: 'dev dependency',
  optionalPeerDependencies: 'peer dependency',
  unlisted: 'unlisted',
  unresolved: 'unresolved',
  binaries: 'binary',
  catalog: 'catalog',
  cycles: 'cycle',
};

function countsBreakdown(counts: Partial<Record<IssueType, number>>): string {
  return (Object.entries(counts) as [IssueType, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${typeLabel(type)}`)
    .join(', ');
}

// File-type icon by extension — purely decorative (matches the design
// spec's "lucide folder/file icons" bullet); falls back to a generic file
// glyph for anything not explicitly recognized.
const JSON_EXTS = new Set(['json', 'jsonc']);
const TEXT_EXTS = new Set(['md', 'mdx', 'txt', 'yml', 'yaml']);
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'css', 'scss', 'html', 'vue',
]);

function iconForPath(path: string): ComponentType<{ className?: string }> {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  if (JSON_EXTS.has(ext)) return FileJson;
  if (TEXT_EXTS.has(ext)) return FileText;
  if (CODE_EXTS.has(ext)) return FileCode2;
  return File;
}

function CountBadges({
  counts,
  excludeFiles,
}: {
  counts: Partial<Record<IssueType, number>>;
  excludeFiles?: boolean;
}) {
  const entries = (Object.entries(counts) as [IssueType, number][]).filter(
    ([type, n]) => n > 0 && !(excludeFiles && type === 'files'),
  );
  if (entries.length === 0) return null;
  // Rows are fixed-height (virtualized — see TreeView's estimateSize), so
  // badges must never wrap onto a second line: that would spill outside the
  // row's box and visually overlap the next virtualized row. Clip
  // overflowing badges instead of wrapping; the full set is still visible
  // by widening the window or opening the file.
  return (
    <span className="flex min-w-0 shrink flex-nowrap items-center gap-1 overflow-hidden">
      {entries.map(([type, n]) => (
        <span
          key={type}
          className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
        >
          {n} {TYPE_BADGE_LABELS[type]}
          {n === 1 ? '' : 's'}
        </span>
      ))}
    </span>
  );
}

function UnusedFileBadge() {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] leading-none text-amber-900 dark:bg-amber-800 dark:text-amber-100">
      unused file
    </span>
  );
}

export function TriStateCheckbox({
  state,
  disabled,
  title,
  ariaLabel,
  onChange,
}: {
  state: 'none' | 'some' | 'all';
  disabled: boolean;
  title?: string;
  ariaLabel: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onChange={onChange}
      // Rows are whole-row clickable (dir toggles expansion, file opens the
      // file) — the checkbox must swallow both the click AND the keyboard
      // activation (Space bubbles as a keydown to the row's own handler
      // otherwise) so checking a box never also fires the row's action.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="shrink-0 disabled:cursor-not-allowed"
    />
  );
}

// Only present when both isFixable and isIgnorable say no — the disabled
// checkbox's tooltip explains why. Exported for the Packages page's (Task 4)
// and CodePane's per-row/badge tooltips.
export function unactionableReason(issue: Issue): string {
  const fix = isFixable(issue);
  const ignore = isIgnorable(issue);
  return [fix.reason, ignore.reason].filter(Boolean).join(' / ');
}

const ROW_BASE =
  'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-sm px-2 text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring';

export function TreeNodeRow({
  row,
  selected,
  enabledTypes,
  onToggleExpand,
  onToggleIds,
  onAddFileFiltered,
  onOpenFile,
}: TreeNodeRowProps) {
  const indent = 6 + row.depth * 16;

  // Shared checkbox-click semantics for both dir and file rows: a fully-
  // checked node (relative to enabledTypes) clears via the ordinary toggle;
  // anything else adds the enabled-type actionable issues under it via
  // addFileFiltered — a pure add that never drops a cart item belonging to a
  // currently-disabled type (see selection.ts's addFileFiltered doc comment
  // for why this is what makes the cart survive filter toggles).
  function handleCheckboxChange(node: DirNode | FileNode) {
    const state = nodeSelectionState(node, selected, enabledTypes);
    if (state === 'all') {
      onToggleIds(idsToToggleForNode(node, selected, enabledTypes));
    } else {
      onAddFileFiltered(collectFileIssues(node), enabledTypes);
    }
  }

  if (row.kind === 'dir') {
    const { node, expanded } = row;
    const state = nodeSelectionState(node, selected, enabledTypes);
    const disabled = scopedActionableIds(node, enabledTypes).length === 0;
    const FolderIcon = expanded ? FolderOpen : Folder;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        aria-expanded={expanded}
        data-testid={`tree-dir-${node.path}`}
        onClick={() => onToggleExpand(node.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand(node.path);
          }
        }}
        className={ROW_BASE}
        style={{ paddingLeft: indent }}
      >
        <svg
          viewBox="0 0 24 24"
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <TriStateCheckbox
          state={state}
          disabled={disabled}
          ariaLabel={`Select all issues in ${node.path}/`}
          title={disabled ? 'No fixable or ignorable issues in this directory' : undefined}
          onChange={() => handleCheckboxChange(node)}
        />
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 shrink truncate font-medium">{node.name}/</span>
        {node.totalCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">{node.totalCount}</span>
            </TooltipTrigger>
            <TooltipContent>{countsBreakdown(node.counts)}</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  const { node } = row;
  const state = nodeSelectionState(node, selected, enabledTypes);
  const disabled = scopedActionableIds(node, enabledTypes).length === 0;
  const FileIcon = iconForPath(node.path);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={node.name}
      data-testid={`tree-file-${node.path}`}
      title={node.path}
      onClick={() => onOpenFile(node.path)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenFile(node.path);
        }
      }}
      className={ROW_BASE}
      style={{ paddingLeft: indent }}
    >
      <span className="w-3 shrink-0" />
      <TriStateCheckbox
        state={state}
        disabled={disabled}
        ariaLabel={`Select issues in ${node.path}`}
        title={disabled ? 'No fixable or ignorable issues in this file' : undefined}
        onChange={() => handleCheckboxChange(node)}
      />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 shrink truncate">{node.name}</span>
      {(node.counts.files ?? 0) > 0 && <UnusedFileBadge />}
      <CountBadges counts={node.counts} excludeFiles />
    </div>
  );
}
