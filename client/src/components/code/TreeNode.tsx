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
import { File, FileCode2, FileJson, FileText, FlaskConical, Folder, FolderOpen } from 'lucide-react';
import type { Issue, IssueType } from '../../../../src/core/types.js';
import { isFixable, isIgnorable, isLikelyTestFile, typeLabel } from '../../lib/filters.js';
import { pluralizeType } from '../../lib/pluralize.js';
import {
  nodeSelectionState,
  scopedActionableIds,
  toggleNodeSelection,
  type DirNode,
  type FileNode,
  type FlatRow,
} from '../../lib/tree.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

// Re-exported for callers that only ever imported FlatRow from here (Task 3
// originally defined it in this file) — the real definition moved to
// lib/tree.ts for Task K/#13 so the React-free treeKeyAction helper could use
// it too; nothing here should define it again.
export type { FlatRow } from '../../lib/tree.js';

export interface TreeNodeRowProps {
  row: FlatRow;
  /**
   * This row's own index into TreeView's flattened `rows` — needed for the
   * roving-tabindex contract below (Task K, #13): registering this row's DOM
   * node for keyboard-driven focus/scrollToIndex, and reporting a click as
   * "the user just activated row N" so mouse -> keyboard handoff picks up
   * from wherever they clicked rather than snapping back to the tree's own
   * last-remembered index.
   */
  index: number;
  /** True on exactly one row at a time (TreeView's activeIndex) — drives roving tabIndex (0 here, -1 elsewhere) per the ARIA tree pattern. */
  active: boolean;
  /** Registers/unregisters this row's root DOM node under `index` so TreeView can imperatively .focus() it after a keyboard move scrolls it into view (virtualization means the node doesn't exist until then). */
  registerRowRef: (index: number, el: HTMLDivElement | null) => void;
  /** Fired on click (in addition to the row's own open/toggle-expand action) so activeIndex tracks the mouse, not just the keyboard. */
  onActivate: (index: number) => void;
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

// Pluralized ("2 exports, 1 file"), not typeLabel()'s always-plural category
// label ("Unused exports") — see lib/pluralize.ts's doc comment for why
// those two are kept separate (typeLabel would read as "1 Unused exports"
// at n=1).
function countsBreakdown(counts: Partial<Record<IssueType, number>>): string {
  return (Object.entries(counts) as [IssueType, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => pluralizeType(n, type))
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
  // by widening the window or opening the file. Text is pluralizeType's
  // count+noun (Task 2, v0.3) rather than TYPE_BADGE_LABELS + a bare
  // conditional 's' — the old ad hoc suffix was actually wrong for `files`
  // (TYPE_BADGE_LABELS.files is already the plural 'files', so a singular
  // count rendered "1 files"); pluralizeType is the single source of truth
  // for singular/plural per type everywhere a count is shown.
  return (
    <span className="flex min-w-0 shrink flex-nowrap items-center gap-1 overflow-hidden">
      {entries.map(([type, n]) => (
        <span
          key={type}
          className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
        >
          {pluralizeType(n, type)}
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

// Test-file hint (Task 4, v0.3): shown next to an unused-file badge whenever
// `isLikelyTestFile` (lib/filters.ts) flags the path — knip flagging a whole
// test file as "unused" is very often just a missing test-runner plugin
// config rather than genuinely dead code. Shared by TreeNodeRow's file rows
// below and CodePane's whole-file banner (same icon/copy/link in both
// places, so the hint reads as one consistent affordance regardless of where
// the user encounters the issue).
export function TestFileHint() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* preventDefault suppresses a subtle side-effect where CodePane's
            WholeFileBanner renders this inside a <label>: without it, a
            click here would ALSO toggle the label's wrapped checkbox (the
            browser's default "click bubbled to label -> activate the
            associated control" behavior) — this icon is informational only,
            not another way to (de)select the issue. stopPropagation mirrors
            TriStateCheckbox's own guard so a click here never also fires the
            tree row's onOpenFile. */}
        <FlaskConical
          className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300"
          aria-label="Likely a test file"
          data-testid="test-file-hint"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </TooltipTrigger>
      <TooltipContent>
        Looks like a test file — knip may be missing your test runner&apos;s config.{' '}
        <a
          href="https://knip.dev/reference/plugins"
          target="_blank"
          rel="noreferrer"
          className="underline"
          onClick={(e) => e.stopPropagation()}
        >
          docs
        </a>
      </TooltipContent>
    </Tooltip>
  );
}

// ARIA choice (Task K, #13's design brief explicitly calls this out as a
// pick-and-document decision): a treeitem row with a selection checkbox
// keeps that checkbox as its OWN accessible control — a real native
// `<input type="checkbox">` with its own aria-label/checked/indeterminate
// state — rather than mirroring tri-state selection onto the row's
// aria-checked. The APG's checkbox-tree pattern (a tree where every treeitem
// doubles as a tristate checkbox, no separate control) doesn't fit here: this
// tree's checkbox and its row are two INDEPENDENT actions with different
// targets (the checkbox selects issues into the fix/ignore cart; the row
// itself opens a file or expands a dir), so collapsing them into one
// aria-checked on the treeitem would misdescribe the row's primary action to
// assistive tech. Native `<input>` semantics already give screen readers
// checked/unchecked/mixed for free — see the `state==='some'`
// `indeterminate` line below.
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
      // ACTIVATION keys, so checking a box never also fires the row's/tree's
      // own action: Space is the checkbox's native toggle (letting it bubble
      // would ALSO toggle-select whatever row is tree-active — possibly a
      // different row than this checkbox's, double-mutating the cart), and
      // Enter bubbling to TreeView's handler would open/expand the active
      // row as a surprise side effect of interacting with a checkbox. Only
      // those two, though (#13 review — this used to swallow EVERY key):
      // arrows/Home/End pressed while a checkbox has focus must keep
      // bubbling to the tree's keydown handler so keyboard navigation
      // resumes from a focused checkbox instead of dying until Tab.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
      }}
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
  index,
  active,
  registerRowRef,
  onActivate,
  selected,
  enabledTypes,
  onToggleExpand,
  onToggleIds,
  onAddFileFiltered,
  onOpenFile,
}: TreeNodeRowProps) {
  const indent = 6 + row.depth * 16;

  // Shared checkbox-click semantics for both dir and file rows — see
  // toggleNodeSelection's own doc comment (lib/tree.ts). Kept as a thin
  // per-row wrapper (rather than calling toggleNodeSelection directly at each
  // call site below) purely to close over onToggleIds/onAddFileFiltered/
  // selected/enabledTypes once.
  function handleCheckboxChange(node: DirNode | FileNode) {
    toggleNodeSelection(node, selected, enabledTypes, onToggleIds, onAddFileFiltered);
  }

  // Roving tabindex (ARIA tree pattern, Task K/#13): exactly the active ROW
  // is in the Tab order (tabIndex 0); every other row is -1, so the rows
  // themselves contribute one Tab stop and TreeView's own keydown handler —
  // not the browser's default Tab-through-everything — owns row-to-row
  // movement. NOTE (#13 review): this is rows-only, not "the whole tree is
  // one Tab stop" — each mounted row's TriStateCheckbox keeps its native tab
  // stop by design (it's an independent accessible control, see the
  // ARIA-choice comment above TriStateCheckbox), so Tab still visits every
  // visible checkbox. Enter/Space no longer have their own onKeyDown here
  // (that used to treat both identically): TreeView's container-level
  // handler now decides via treeKeyAction, since Space's meaning changed
  // (toggles the row's own checkbox, not "same as Enter") and needs the full
  // row list to do so.
  const roving = {
    ref: (el: HTMLDivElement | null) => registerRowRef(index, el),
    tabIndex: active ? 0 : -1,
    'data-active': active || undefined,
  } as const;

  if (row.kind === 'dir') {
    const { node, expanded, setSize, posInSet } = row;
    const state = nodeSelectionState(node, selected, enabledTypes);
    const disabled = scopedActionableIds(node, enabledTypes).length === 0;
    const FolderIcon = expanded ? FolderOpen : Folder;
    return (
      <div
        {...roving}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        // Just the item's own name here — role="treeitem" already announces
        // "expanded"/"collapsed" via aria-expanded below (per APG); baking
        // "Collapse "/"Expand " into the accessible NAME, as the pre-Task-K
        // role="button" version did, duplicated that state in the label.
        aria-label={`${node.name}/`}
        aria-expanded={expanded}
        data-testid={`tree-dir-${node.path}`}
        onClick={() => {
          onActivate(index);
          onToggleExpand(node.path);
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

  const { node, setSize, posInSet } = row;
  const state = nodeSelectionState(node, selected, enabledTypes);
  const disabled = scopedActionableIds(node, enabledTypes).length === 0;
  const FileIcon = iconForPath(node.path);
  return (
    <div
      {...roving}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      aria-label={node.name}
      data-testid={`tree-file-${node.path}`}
      title={node.path}
      onClick={() => {
        onActivate(index);
        onOpenFile(node.path);
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
      {(node.counts.files ?? 0) > 0 && isLikelyTestFile(node.path) && <TestFileHint />}
      <CountBadges counts={node.counts} excludeFiles />
    </div>
  );
}
