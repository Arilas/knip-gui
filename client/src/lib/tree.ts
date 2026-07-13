// Pure tree-building logic for the Tree view (Task 3): turns a flat list of
// file-bearing issues (facets.ts's issuesForFacet('tree', ...), or a
// per-type facet's — this module doesn't care which) into a nested dir/file
// tree, with rollup counts and tri-state selection helpers. No React, no
// store — unit-tested directly in tests/client/tree.test.ts.
import type { Issue, IssueType } from '../../../src/core/types.js';
import { isFixable, isIgnorable } from './facets.js';

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
  counts: Partial<Record<IssueType, number>>;
}

export type TreeNode = DirNode | FileNode;

function isActionable(issue: Issue): boolean {
  return isFixable(issue).ok || isIgnorable(issue).ok;
}

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
  const actionableIds = fileIssues.filter(isActionable).map((i) => i.id);
  const counts: Partial<Record<IssueType, number>> = {};
  for (const issue of fileIssues) counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  return { kind: 'file', name: mfile.name, path: mfile.path, fileIssues, issueIds, actionableIds, counts };
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

  return {
    kind: 'dir',
    name,
    path,
    children,
    issueIds: children.flatMap((c) => c.issueIds),
    actionableIds: children.flatMap((c) => c.actionableIds),
    counts: rollupCounts(children),
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
  return {
    kind: 'dir',
    name: '',
    path: '',
    children,
    issueIds: children.flatMap((c) => c.issueIds),
    actionableIds: children.flatMap((c) => c.actionableIds),
    counts: rollupCounts(children),
  };
}

// Duck-typed rather than TreeNode-specific: TableView's "select all" header
// checkbox has no real dir/file node, just a flat list of visible rows — it
// builds an ad-hoc { actionableIds } to reuse this same tri-state/toggle
// logic instead of re-deriving it.
export interface ActionableIdsHolder {
  actionableIds: string[];
}

/**
 * Tri-state selection for a dir/file node (or any { actionableIds } holder):
 * only ids that are fixable or ignorable count (an unfixable+unignorable
 * issue can never be selected, so it must never make a node's checkbox read
 * "some" on its own). A node with zero actionable ids always reads 'none' —
 * the UI disables its checkbox in that case (check `actionableIds.length
 * === 0`).
 */
export function nodeSelectionState(
  node: ActionableIdsHolder,
  selectedIds: ReadonlySet<string> | Iterable<string>,
): 'none' | 'some' | 'all' {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const { actionableIds } = node;
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
): string[] {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const state = nodeSelectionState(node, selected);
  if (state === 'all') return node.actionableIds;
  return node.actionableIds.filter((id) => !selected.has(id));
}
