// Pure tree-building logic for the Tree view (Task 3): turns a flat list of
// file-bearing issues (lib/filters.ts's filterIssues output, typically) into
// a nested dir/file tree, with rollup counts and tri-state selection
// helpers. No React, no store — unit-tested directly in
// tests/client/tree.test.ts.
import type { Issue, IssueType } from '../../../src/core/types.js';
import { isActionable } from './filters.js';

export interface FileNode {
  kind: 'file';
  /** Just the basename — directories are never merged into a file's name. */
  name: string;
  /** Full path from the tree root, e.g. "src/used.ts". */
  path: string;
  /**
   * Every issue located at this file, including file-level issues (e.g. an
   * unused 'files' issue, which carries no line) — sorted by line, with
   * line-less issues first. Whole-file issues render as a badge on the file
   * row itself, not as a child row (see design's tree view bullet).
   */
  fileIssues: Issue[];
  /** All issue ids for this file (same ids as fileIssues, for convenience). */
  issueIds: string[];
  /**
   * Subset of issueIds that are fixable or ignorable — the only ids that
   * count toward tri-state selection (see nodeSelectionState). A file whose
   * issues are all unfixable+unignorable has an empty actionableIds: its
   * checkbox must render disabled with a reason tooltip.
   */
  actionableIds: string[];
  /**
   * `actionableIds` grouped by IssueType — lets nodeSelectionState/
   * idsToToggleForNode restrict tri-state/toggle behavior to a caller-given
   * set of enabled types (the Code page's filter chips) without needing the
   * full Issue objects at click time.
   */
  actionableIdsByType: Partial<Record<IssueType, string[]>>;
  counts: Partial<Record<IssueType, number>>;
}

export interface DirNode {
  kind: 'dir';
  /**
   * Display name — may be a compressed chain like "components/deep" when
   * every intermediate directory has exactly one child and that child is
   * itself a directory (a directory holding only files, even just one, is
   * never absorbed into its parent's name).
   */
  name: string;
  /** Full path from the tree root, matching the deepest directory folded into this row. */
  path: string;
  children: TreeNode[];
  /** Rollup of every descendant issue id. */
  issueIds: string[];
  /** Rollup of every descendant actionable (fixable or ignorable) issue id. */
  actionableIds: string[];
  /** Rollup of every descendant FileNode's actionableIdsByType (see FileNode). */
  actionableIdsByType: Partial<Record<IssueType, string[]>>;
  counts: Partial<Record<IssueType, number>>;
  /** Sum of every value in `counts` — the single muted count a dir row shows (tooltip has the per-type breakdown). */
  totalCount: number;
}

export type TreeNode = DirNode | FileNode;

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: Map<string, MutableFile>;
}

interface MutableFile {
  name: string;
  path: string;
  issues: Issue[];
}

function getOrCreateDir(parent: MutableDir, segment: string, path: string): MutableDir {
  let dir = parent.dirs.get(segment);
  if (!dir) {
    dir = { name: segment, path, dirs: new Map(), files: new Map() };
    parent.dirs.set(segment, dir);
  }
  return dir;
}

function buildMutableRoot(issues: Issue[]): MutableDir {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: new Map() };
  for (const issue of issues) {
    const segments = issue.filePath.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? issue.filePath;
    const dirSegments = segments.slice(0, -1);

    let cursor = root;
    let path = '';
    for (const segment of dirSegments) {
      path = path ? `${path}/${segment}` : segment;
      cursor = getOrCreateDir(cursor, segment, path);
    }

    let file = cursor.files.get(fileName);
    if (!file) {
      file = { name: fileName, path: issue.filePath, issues: [] };
      cursor.files.set(fileName, file);
    }
    file.issues.push(issue);
  }
  return root;
}

function rollupCounts(children: TreeNode[]): Partial<Record<IssueType, number>> {
  const counts: Partial<Record<IssueType, number>> = {};
  for (const child of children) {
    for (const [type, n] of Object.entries(child.counts) as [IssueType, number][]) {
      counts[type] = (counts[type] ?? 0) + n;
    }
  }
  return counts;
}

function rollupActionableIdsByType(children: TreeNode[]): Partial<Record<IssueType, string[]>> {
  const byType: Partial<Record<IssueType, string[]>> = {};
  for (const child of children) {
    for (const [type, ids] of Object.entries(child.actionableIdsByType) as [IssueType, string[]][]) {
      byType[type] = [...(byType[type] ?? []), ...ids];
    }
  }
  return byType;
}

function totalOf(counts: Partial<Record<IssueType, number>>): number {
  return Object.values(counts).reduce((sum: number, n) => sum + (n ?? 0), 0);
}

// Directories first, then files; alphabetical within each group.
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function finalizeFile(mfile: MutableFile): FileNode {
  const fileIssues = [...mfile.issues].sort((a, b) => (a.line ?? -1) - (b.line ?? -1));
  const issueIds = fileIssues.map((i) => i.id);
  const actionableIssues = fileIssues.filter(isActionable);
  const actionableIds = actionableIssues.map((i) => i.id);
  const actionableIdsByType: Partial<Record<IssueType, string[]>> = {};
  for (const issue of actionableIssues) {
    (actionableIdsByType[issue.type] ??= []).push(issue.id);
  }
  const counts: Partial<Record<IssueType, number>> = {};
  for (const issue of fileIssues) counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  return {
    kind: 'file',
    name: mfile.name,
    path: mfile.path,
    fileIssues,
    issueIds,
    actionableIds,
    actionableIdsByType,
    counts,
  };
}

function finalizeChildren(mdir: MutableDir): TreeNode[] {
  const dirs = [...mdir.dirs.values()].map(finalizeDir);
  const files = [...mdir.files.values()].map(finalizeFile);
  return sortNodes([...dirs, ...files]);
}

// Compresses single-child directory chains ("src/components/deep" collapses
// to one row): after a directory's children are finalized (bottom-up, so
// multi-level chains fold in one pass), if exactly one child remains and
// it's itself a directory, absorb its name/path/children into this row and
// repeat. Stops the moment a directory branches (2+ children) or its only
// child is a file.
function finalizeDir(mdir: MutableDir): DirNode {
  let name = mdir.name;
  let path = mdir.path;
  let children = finalizeChildren(mdir);

  while (children.length === 1 && children[0]!.kind === 'dir') {
    const only = children[0] as DirNode;
    name = `${name}/${only.name}`;
    path = only.path;
    children = only.children;
  }

  const counts = rollupCounts(children);
  return {
    kind: 'dir',
    name,
    path,
    children,
    issueIds: children.flatMap((c) => c.issueIds),
    actionableIds: children.flatMap((c) => c.actionableIds),
    actionableIdsByType: rollupActionableIdsByType(children),
    counts,
    totalCount: totalOf(counts),
  };
}

/**
 * Builds the nested dir/file tree from a flat list of file-bearing issues.
 * The returned node is a synthetic, unnamed root at path '' — render
 * `root.children`, never the root row itself (it's never compressed away,
 * so a single-top-level-dir tree still shows that dir's own, possibly
 * further-compressed, name as the first visible row).
 */
export function buildTree(issues: Issue[]): DirNode {
  const mutableRoot = buildMutableRoot(issues);
  const children = finalizeChildren(mutableRoot);
  const counts = rollupCounts(children);
  return {
    kind: 'dir',
    name: '',
    path: '',
    children,
    issueIds: children.flatMap((c) => c.issueIds),
    actionableIds: children.flatMap((c) => c.actionableIds),
    actionableIdsByType: rollupActionableIdsByType(children),
    counts,
    totalCount: totalOf(counts),
  };
}

/** Every FileNode's `fileIssues` under a node (itself, for a file; its full subtree, for a dir) — used to drive `selection.ts`'s `addFileFiltered` for a dir/file checkbox click, which needs the real Issue objects (not just ids) to apply the enabled-type filter. */
export function collectFileIssues(node: TreeNode): Issue[] {
  if (node.kind === 'file') return node.fileIssues;
  return node.children.flatMap(collectFileIssues);
}

/** Count of FileNodes under a node (itself if a file; its full subtree if a dir) — used to feed `autoExpandDepth`'s visibleFileCount. */
export function countFiles(node: TreeNode): number {
  if (node.kind === 'file') return 1;
  return node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

const AUTO_EXPAND_FILE_THRESHOLD = 200;

/**
 * Initial expand policy for the tree, based on how many files are currently
 * visible (post search/filter): 'all' expands every directory (fine up to a
 * couple hundred files), 'top' expands only the tree's top-level directories
 * so a huge project doesn't dump thousands of rows into the DOM/virtualizer
 * on first paint.
 */
export function autoExpandDepth(tree: DirNode, visibleFileCount: number): 'all' | 'top' {
  if (tree.children.length === 0) return 'all';
  return visibleFileCount <= AUTO_EXPAND_FILE_THRESHOLD ? 'all' : 'top';
}

// Duck-typed rather than TreeNode-specific: the Packages page's (Task 4)
// per-workspace-group "select all" header checkbox has no real dir/file
// node, just a flat list of that group's issues — it builds an ad-hoc
// { actionableIds } to reuse this same tri-state/toggle logic instead of
// re-deriving it. `actionableIdsByType` is optional so that
// ad-hoc holder keeps working unchanged; it's only consulted when a caller
// passes `enabledTypes` to nodeSelectionState/idsToToggleForNode.
export interface ActionableIdsHolder {
  actionableIds: string[];
  actionableIdsByType?: Partial<Record<IssueType, string[]>>;
}

// Restricts a node's actionableIds to only the ids belonging to
// `enabledTypes` (the Code page's filter chips) — when `enabledTypes` is
// omitted, every actionable id counts, preserving the pre-Task-3 2-arg
// behavior exactly. Exported so TreeNode.tsx can compute "is this row's
// checkbox disabled" without duplicating the enabledTypes-scoping logic.
export function scopedActionableIds(node: ActionableIdsHolder, enabledTypes?: ReadonlySet<IssueType>): string[] {
  if (!enabledTypes) return node.actionableIds;
  const byType = node.actionableIdsByType ?? {};
  const out: string[] = [];
  for (const [type, ids] of Object.entries(byType) as [IssueType, string[]][]) {
    if (enabledTypes.has(type)) out.push(...ids);
  }
  return out;
}

/**
 * Tri-state selection for a dir/file node (or any { actionableIds } holder):
 * only ids that are fixable or ignorable count (an unfixable+unignorable
 * issue can never be selected, so it must never make a node's checkbox read
 * "some" on its own). A node with zero actionable ids always reads 'none' —
 * the UI disables its checkbox in that case (check `actionableIds.length
 * === 0`).
 *
 * When `enabledTypes` is given (the Code page's currently-enabled filter
 * chips), only actionable ids of an enabled type count toward the tri-state
 * — an issue of a disabled type never makes a row read "some"/"all", even if
 * it happens to be selected (the cart is never pruned by filter changes; see
 * selection.ts's addFileFiltered doc comment).
 */
export function nodeSelectionState(
  node: ActionableIdsHolder,
  selectedIds: ReadonlySet<string> | Iterable<string>,
  enabledTypes?: ReadonlySet<IssueType>,
): 'none' | 'some' | 'all' {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const actionableIds = scopedActionableIds(node, enabledTypes);
  if (actionableIds.length === 0) return 'none';
  const selectedCount = actionableIds.filter((id) => selected.has(id)).length;
  if (selectedCount === 0) return 'none';
  return selectedCount === actionableIds.length ? 'all' : 'some';
}

/** Every issue id under a node (itself, for a file; its full subtree, for a dir). */
export function collectIds(node: TreeNode): string[] {
  return node.issueIds;
}

/**
 * Every actionable (fixable or ignorable) issue id under a node — what a
 * dir/file checkbox click should actually toggle in the selection cart
 * (unfixable/unignorable ids are never added, since they'd sit inertly
 * there with no available action).
 */
export function collectActionableIds(node: TreeNode): string[] {
  return node.actionableIds;
}

/**
 * Ids to pass to the selection store's toggle() to make a node's checkbox
 * fully checked (if it isn't already) or fully unchecked (if it is) — never
 * partial. Mirrors standard tri-state checkbox semantics: clicking an
 * empty/partial box selects everything actionable beneath it (without
 * touching ids already selected via some other path); clicking a full box
 * clears it.
 */
export function idsToToggleForNode(
  node: ActionableIdsHolder,
  selectedIds: ReadonlySet<string> | Iterable<string>,
  enabledTypes?: ReadonlySet<IssueType>,
): string[] {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const actionableIds = scopedActionableIds(node, enabledTypes);
  const state = nodeSelectionState(node, selected, enabledTypes);
  if (state === 'all') return actionableIds;
  return actionableIds.filter((id) => !selected.has(id));
}
