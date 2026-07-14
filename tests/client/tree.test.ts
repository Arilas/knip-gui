import { describe, expect, it } from 'vitest';
import type { Issue, IssueType } from '../../src/core/types.js';
import {
  autoExpandDepth,
  buildTree,
  collectActionableIds,
  collectFileIssues,
  collectIds,
  countFiles,
  idsToToggleForNode,
  nodeSelectionState,
} from '../../client/src/lib/tree.js';
import type { DirNode, FileNode, TreeNode } from '../../client/src/lib/tree.js';

let idSeq = 0;
function issue(partial: Partial<Issue> & Pick<Issue, 'type' | 'filePath'>): Issue {
  idSeq += 1;
  return {
    id: `issue-${idSeq}`,
    workspace: '.',
    fixable: false,
    fixModes: [],
    ...partial,
  };
}

function findChild(node: DirNode, name: string): TreeNode {
  const found = node.children.find((c) => c.name === name);
  if (!found) throw new Error(`no child named ${name} among [${node.children.map((c) => c.name).join(', ')}]`);
  return found;
}

describe('buildTree', () => {
  it('returns an unnamed synthetic root whose children are the top-level dirs/files', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'orphan.ts' })]);
    expect(tree.kind).toBe('dir');
    expect(tree.name).toBe('');
    expect(tree.path).toBe('');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.kind).toBe('file');
    expect(tree.children[0]!.name).toBe('orphan.ts');
  });

  it('nests files under their directory', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'src/orphan.ts' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'unusedHelper' }),
    ]);
    expect(tree.children).toHaveLength(1);
    const src = findChild(tree, 'src') as DirNode;
    expect(src.kind).toBe('dir');
    expect(src.path).toBe('src');
    expect(src.children.map((c) => c.name).sort()).toEqual(['orphan.ts', 'used.ts']);
  });

  it('compresses a single-child directory chain into one row', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'src/components/deep/orphan.ts' })]);
    expect(tree.children).toHaveLength(1);
    const compressed = tree.children[0] as DirNode;
    expect(compressed.kind).toBe('dir');
    expect(compressed.name).toBe('src/components/deep');
    expect(compressed.path).toBe('src/components/deep');
    expect(compressed.children).toHaveLength(1);
    expect(compressed.children[0]!.name).toBe('orphan.ts');
  });

  it('stops compressing at the first directory that branches (two subdirs)', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'a/b/c1/x.ts' }),
      issue({ type: 'files', filePath: 'a/b/c2/y.ts' }),
    ]);
    expect(tree.children).toHaveLength(1);
    const ab = tree.children[0] as DirNode;
    expect(ab.name).toBe('a/b');
    expect(ab.children.map((c) => c.name).sort()).toEqual(['c1', 'c2']);
  });

  it('stops compressing at the first directory that branches (dir + file sibling)', () => {
    const tree = buildTree([
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'x' }),
      issue({ type: 'files', filePath: 'src/components/deep/orphan.ts' }),
    ]);
    const src = findChild(tree, 'src') as DirNode;
    expect(src.name).toBe('src');
    expect(src.children.map((c) => c.name).sort()).toEqual(['components/deep', 'used.ts']);
  });

  it('does not compress a directory whose only child is a file (never merges file names into dirs)', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'src/only.ts' })]);
    const src = findChild(tree, 'src') as DirNode;
    expect(src.name).toBe('src');
    expect(src.children).toHaveLength(1);
    expect(src.children[0]!.name).toBe('only.ts');
  });

  it('sorts directories before files, alphabetically within each group', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'zeta.ts' }),
      issue({ type: 'files', filePath: 'alpha/inner.ts' }),
      issue({ type: 'files', filePath: 'beta.ts' }),
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(['alpha', 'beta.ts', 'zeta.ts']);
  });

  it('groups every issue for a file onto one FileNode, including a file-level (no-line) unused-file issue', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'src/orphan.ts' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', line: 10 }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', line: 2 }),
    ]);
    const src = findChild(tree, 'src') as DirNode;
    const orphan = findChild(src, 'orphan.ts') as FileNode;
    expect(orphan.fileIssues).toHaveLength(1);
    expect(orphan.fileIssues[0]!.line).toBeUndefined();
    expect(orphan.counts.files).toBe(1);

    const used = findChild(src, 'used.ts') as FileNode;
    expect(used.fileIssues.map((i) => i.symbol)).toEqual(['a', 'b']); // sorted by line
    expect(used.counts.exports).toBe(2);
  });

  it('rolls up counts by type from files through directories to the root', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'src/orphan.ts' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b' }),
      issue({ type: 'types', filePath: 'src/shapes.ts', symbol: 'T' }),
    ]);
    const src = findChild(tree, 'src') as DirNode;
    expect(src.counts).toEqual({ files: 1, exports: 2, types: 1 });
    expect(tree.counts).toEqual({ files: 1, exports: 2, types: 1 });
    expect(tree.issueIds).toHaveLength(4);
  });

  it('rolls up totalCount (sum of every per-type count) on every DirNode', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'src/orphan.ts' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a' }),
      issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b' }),
      issue({ type: 'types', filePath: 'src/shapes.ts', symbol: 'T' }),
    ]);
    const src = findChild(tree, 'src') as DirNode;
    expect(src.totalCount).toBe(4);
    expect(tree.totalCount).toBe(4);
  });

  it('groups actionableIds by type on both FileNode and DirNode', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const b = issue({ type: 'files', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] });
    const unfixable = issue({ type: 'nsExports', filePath: 'src/used.ts', symbol: 'ns', fixable: false, fixModes: [] });
    const tree = buildTree([a, b, unfixable]);
    const src = findChild(tree, 'src') as DirNode;
    const used = findChild(src, 'used.ts') as FileNode;
    expect(used.actionableIdsByType).toEqual({ exports: [a.id] });
    expect(src.actionableIdsByType.exports).toEqual([a.id]);
    expect(src.actionableIdsByType.files).toEqual([b.id]);
    expect(src.actionableIdsByType.nsExports).toBeUndefined();
  });
});

describe('nodeSelectionState', () => {
  const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
  const b = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] });
  const unfixable = issue({ type: 'nsExports', filePath: 'src/used.ts', symbol: 'ns', fixable: false, fixModes: [] });

  it('is "none" when no actionable ids are selected', () => {
    const tree = buildTree([a, b]);
    const file = findChild(tree, 'src') && (findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode);
    expect(nodeSelectionState(file, new Set())).toBe('none');
  });

  it('is "all" when every actionable id is selected', () => {
    const tree = buildTree([a, b]);
    const file = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    expect(nodeSelectionState(file, new Set([a.id, b.id]))).toBe('all');
  });

  it('is "some" when a strict subset of actionable ids is selected', () => {
    const tree = buildTree([a, b]);
    const file = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    expect(nodeSelectionState(file, new Set([a.id]))).toBe('some');
  });

  it('excludes unfixable/unignorable issues from the actionable count entirely', () => {
    const tree = buildTree([a, unfixable]);
    const file = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    expect(file.actionableIds).toEqual([a.id]);
    expect(nodeSelectionState(file, new Set([a.id]))).toBe('all');
    // Selecting only the unfixable id (which should never happen via the UI,
    // since it has no enabled checkbox) still reads 'none' — it doesn't count.
    expect(nodeSelectionState(file, new Set([unfixable.id]))).toBe('none');
  });

  it('is "none" for a node with zero actionable issues, regardless of selectedIds (disabled checkbox case)', () => {
    const tree = buildTree([unfixable]);
    const file = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    expect(file.actionableIds).toHaveLength(0);
    expect(nodeSelectionState(file, new Set([unfixable.id]))).toBe('none');
  });

  it('rolls tri-state up through directories', () => {
    const c = issue({ type: 'files', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] });
    const tree = buildTree([a, b, c]);
    const src = findChild(tree, 'src') as DirNode;
    expect(nodeSelectionState(src, new Set([a.id, b.id, c.id]))).toBe('all');
    expect(nodeSelectionState(src, new Set([a.id]))).toBe('some');
    expect(nodeSelectionState(src, new Set())).toBe('none');
  });

  describe('with enabledTypes (Task 3 filter-aware tri-state)', () => {
    it('counts only issues matching the currently-enabled types', () => {
      // A tree built from the FULL (unfiltered) issue set — the point of
      // enabledTypes is that nodeSelectionState still gates correctly even
      // when the caller didn't pre-filter the tree by type.
      const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
      const enumM = issue({ type: 'enumMembers', filePath: 'src/used.ts', symbol: 'm', fixable: true, fixModes: ['remove-member'] });
      const tree = buildTree([exp, enumM]);
      const used = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;

      // Both selected, but 'exports' is disabled: only enumMembers counts.
      const enabled = new Set<IssueType>(['enumMembers']);
      expect(nodeSelectionState(used, new Set([exp.id, enumM.id]), enabled)).toBe('all');
      expect(nodeSelectionState(used, new Set([enumM.id]), enabled)).toBe('all');
      expect(nodeSelectionState(used, new Set([exp.id]), enabled)).toBe('none');
    });

    it('reads "none" when every actionable issue at this node is of a disabled type', () => {
      const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
      const tree = buildTree([exp]);
      const used = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
      expect(nodeSelectionState(used, new Set([exp.id]), new Set<IssueType>(['enumMembers']))).toBe('none');
    });

    it('rolls enabledTypes-scoped tri-state up through directories', () => {
      const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
      const fileIssue = issue({ type: 'files', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] });
      const tree = buildTree([exp, fileIssue]);
      const src = findChild(tree, 'src') as DirNode;
      const enabled = new Set<IssueType>(['files']);
      expect(nodeSelectionState(src, new Set([fileIssue.id]), enabled)).toBe('all');
      expect(nodeSelectionState(src, new Set([exp.id]), enabled)).toBe('none');
    });
  });
});

describe('collectIds / collectActionableIds', () => {
  it('collectIds returns every descendant issue id', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a' });
    const c = issue({ type: 'files', filePath: 'src/orphan.ts' });
    const tree = buildTree([a, c]);
    expect(collectIds(tree).sort()).toEqual([a.id, c.id].sort());
  });

  it('collectActionableIds excludes unfixable/unignorable ids', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const unfixable = issue({ type: 'nsExports', filePath: 'src/used.ts', symbol: 'ns', fixable: false, fixModes: [] });
    const tree = buildTree([a, unfixable]);
    expect(collectActionableIds(tree)).toEqual([a.id]);
  });
});

describe('idsToToggleForNode', () => {
  it('selects every actionable id when none (or only some) are selected', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const b = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] });
    const tree = buildTree([a, b]);
    expect(idsToToggleForNode(tree, new Set())).toEqual([a.id, b.id]);
  });

  it('leaves already-selected ids alone when going from "some" to "all" (only returns the missing ones)', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const b = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] });
    const tree = buildTree([a, b]);
    expect(idsToToggleForNode(tree, new Set([a.id]))).toEqual([b.id]);
  });

  it('clears every actionable id when the node is fully selected', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const b = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] });
    const tree = buildTree([a, b]);
    expect(idsToToggleForNode(tree, new Set([a.id, b.id])).sort()).toEqual([a.id, b.id].sort());
  });

  it('works against an ad-hoc { actionableIds } holder (Packages page select-all use case)', () => {
    expect(idsToToggleForNode({ actionableIds: ['x', 'y'] }, new Set(['x']))).toEqual(['y']);
  });

  it('restricts to enabled types: selects only the enabled-type ids, ignores a disabled-type id even if unselected', () => {
    const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
    const enumM = issue({ type: 'enumMembers', filePath: 'src/used.ts', symbol: 'm', fixable: true, fixModes: ['remove-member'] });
    const tree = buildTree([exp, enumM]);
    const used = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    const enabled = new Set<IssueType>(['enumMembers']);
    expect(idsToToggleForNode(used, new Set(), enabled)).toEqual([enumM.id]);
  });

  it('clearing a fully-enabled-selected node never touches a disabled-type id that happens to be selected too (cart survives filter toggles)', () => {
    const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
    const enumM = issue({ type: 'enumMembers', filePath: 'src/used.ts', symbol: 'm', fixable: true, fixModes: ['remove-member'] });
    const tree = buildTree([exp, enumM]);
    const used = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    const enabled = new Set<IssueType>(['enumMembers']);
    // Both exp and enumM are selected; only enumMembers is enabled, so the
    // node reads 'all' (enumM is the only id that counts) and toggling
    // clears just that id — exp (the disabled/hidden type) is untouched.
    expect(idsToToggleForNode(used, new Set([exp.id, enumM.id]), enabled)).toEqual([enumM.id]);
  });
});

describe('collectFileIssues', () => {
  it('returns a file node\'s own fileIssues', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a' });
    const tree = buildTree([a]);
    const used = findChild(findChild(tree, 'src') as DirNode, 'used.ts') as FileNode;
    expect(collectFileIssues(used)).toEqual(used.fileIssues);
  });

  it('flattens every descendant file\'s fileIssues for a dir node', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a' });
    const b = issue({ type: 'files', filePath: 'src/orphan.ts' });
    const tree = buildTree([a, b]);
    const src = findChild(tree, 'src') as DirNode;
    expect(collectFileIssues(src).map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('countFiles', () => {
  it('counts 1 for a single file node', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'src/orphan.ts' })]);
    const src = findChild(tree, 'src') as DirNode;
    expect(countFiles(findChild(src, 'orphan.ts'))).toBe(1);
  });

  it('counts every file under a dir, recursively', () => {
    const tree = buildTree([
      issue({ type: 'files', filePath: 'src/a.ts' }),
      issue({ type: 'files', filePath: 'src/nested/b.ts' }),
      issue({ type: 'files', filePath: 'src/nested/c.ts' }),
    ]);
    expect(countFiles(tree)).toBe(3);
  });
});

describe('autoExpandDepth', () => {
  it('returns "all" when the tree has no children', () => {
    const tree = buildTree([]);
    expect(autoExpandDepth(tree, 0)).toBe('all');
  });

  it('returns "all" when visibleFileCount is at or below the 200-file threshold', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'src/a.ts' })]);
    expect(autoExpandDepth(tree, 1)).toBe('all');
    expect(autoExpandDepth(tree, 200)).toBe('all');
  });

  it('returns "top" once visibleFileCount exceeds the 200-file threshold', () => {
    const tree = buildTree([issue({ type: 'files', filePath: 'src/a.ts' })]);
    expect(autoExpandDepth(tree, 201)).toBe('top');
  });
});
