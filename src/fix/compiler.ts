import { join, resolve } from 'node:path';
import type { FixMode, Issue } from '../core/types.js';
import { renderDiff } from './diff.js';
import { hashContent, type FilePatch } from './patch.js';
import { newPlanId, readFileOrNull, type FixPlan, type PlanItem } from './plan.js';
import { deleteDeclaration } from './transforms/delete-declaration.js';
import { removeDependency, type PackageJsonIssueType } from './transforms/package-json.js';
import { removeDuplicate } from './transforms/remove-duplicate.js';
import { removeMember } from './transforms/remove-member.js';
import type { TransformInput, TransformResult } from './transforms/source.js';
import { stripExport } from './transforms/strip-export.js';

export interface FixSelection {
  issueIds: string[];
  modeOverrides?: Record<string, FixMode>; // default mode = issue.fixModes[0]
}

// --- fix plan ---

interface SourceOp {
  issueId: string;
  mode: FixMode;
  symbol: string;
  pos?: number;
  parentSymbol?: string;
}

function runSourceTransform(mode: FixMode, input: TransformInput, parentSymbol?: string): TransformResult {
  switch (mode) {
    case 'strip-export':
      return stripExport(input);
    case 'delete-declaration':
      return deleteDeclaration(input);
    case 'remove-duplicate':
      return removeDuplicate(input);
    case 'remove-member':
      if (parentSymbol === undefined) {
        return { ok: false, reason: 'remove-member requires a parentSymbol' };
      }
      return removeMember({ ...input, parentSymbol });
    default:
      // 'delete-file' and 'remove-dependency' are handled by dedicated code
      // paths in compileFixPlan and never reach this dispatcher.
      return { ok: false, reason: `unsupported fix mode '${mode}'` };
  }
}

// Runs a file's queued source-transform ops in descending-pos order, threading
// content from one transform to the next: transform 1 runs on the original
// content, transform 2 on transform 1's output, etc. Only the FIRST transform
// in the whole sequence is given `pos` — the content it operates on is still
// byte-identical to what knip measured `pos` against. Every later transform's
// target has potentially shifted, so it is re-located by `symbol` name alone
// (every transform module already supports symbol-only lookup for this reason).
// A transform failure does not abort the chain: it's recorded against that
// op's issueId and the chain continues from the last successfully-produced
// content. Multiple ops can share one issueId (a `duplicates` issue explodes
// into one op per alias in `duplicateMembers[1..]`) — the final item for that
// issueId is ok:true only if ALL of its ops succeeded.
function runSourceChain(
  filePath: string,
  contentBefore: string,
  ops: SourceOp[],
): { content: string; changed: boolean; items: PlanItem[] } {
  const sorted = [...ops].sort((a, b) => (b.pos ?? -1) - (a.pos ?? -1));
  const resultsByIssue = new Map<string, TransformResult[]>();
  let current = contentBefore;
  let changed = false;

  sorted.forEach((op, idx) => {
    const input: TransformInput = {
      filePath,
      content: current,
      symbol: op.symbol,
      pos: idx === 0 ? op.pos : undefined,
    };
    const result = runSourceTransform(op.mode, input, op.parentSymbol);
    if (result.ok) {
      current = result.newContent;
      changed = true;
    }
    const list = resultsByIssue.get(op.issueId) ?? [];
    list.push(result);
    resultsByIssue.set(op.issueId, list);
  });

  const items: PlanItem[] = [];
  for (const [issueId, results] of resultsByIssue) {
    const failed = results.find((r): r is { ok: false; reason: string } => !r.ok);
    items.push(
      failed ? { issueId, ok: false, reason: failed.reason, filePath } : { issueId, ok: true, filePath },
    );
  }

  return { content: current, changed, items };
}

export async function compileFixPlan(
  projectDir: string,
  issues: Issue[],
  selection: FixSelection,
): Promise<FixPlan> {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const items: PlanItem[] = [];
  const patches: FilePatch[] = [];
  const diffs: { filePath: string; diff: string }[] = [];

  const sourceOpsByFile = new Map<string, SourceOp[]>();
  const deleteFileIssuesByFile = new Map<string, string[]>();
  interface DepOp {
    issueId: string;
    depName: string;
    issueType: PackageJsonIssueType;
  }
  const depOpsByPkg = new Map<string, DepOp[]>();

  for (const issueId of selection.issueIds) {
    const issue = issueById.get(issueId);
    if (!issue) {
      items.push({ issueId, ok: false, reason: 'unknown-issue' });
      continue;
    }
    if (issue.fixModes.length === 0) {
      items.push({ issueId, ok: false, reason: 'not-fixable', filePath: issue.filePath });
      continue;
    }
    const mode = selection.modeOverrides?.[issueId] ?? issue.fixModes[0]!;
    if (!issue.fixModes.includes(mode)) {
      items.push({ issueId, ok: false, reason: 'invalid-mode', filePath: issue.filePath });
      continue;
    }

    if (mode === 'delete-file') {
      const list = deleteFileIssuesByFile.get(issue.filePath) ?? [];
      list.push(issueId);
      deleteFileIssuesByFile.set(issue.filePath, list);
      continue;
    }

    if (mode === 'remove-dependency') {
      // Dep issues target the owning workspace's package.json, not
      // `issue.filePath` — computed explicitly (rather than trusted from the
      // report) so this stays correct regardless of what knip's own `file`
      // field says for a dependency-shaped entry.
      const pkgPath = issue.workspace === '.' ? 'package.json' : join(issue.workspace, 'package.json');
      const list = depOpsByPkg.get(pkgPath) ?? [];
      list.push({ issueId, depName: issue.symbol!, issueType: issue.type as PackageJsonIssueType });
      depOpsByPkg.set(pkgPath, list);
      continue;
    }

    if (mode === 'remove-duplicate') {
      // duplicateMembers[0] is the canonical/original declaration — never
      // touched. Every alias (index 1+) gets its own removeDuplicate call.
      const members = (issue.duplicateMembers ?? []).slice(1);
      if (members.length === 0) {
        items.push({ issueId, ok: false, reason: 'no-duplicate-members', filePath: issue.filePath });
        continue;
      }
      const list = sourceOpsByFile.get(issue.filePath) ?? [];
      for (const m of members) list.push({ issueId, mode, symbol: m.symbol, pos: m.pos });
      sourceOpsByFile.set(issue.filePath, list);
      continue;
    }

    // strip-export | delete-declaration | remove-member
    const list = sourceOpsByFile.get(issue.filePath) ?? [];
    list.push({ issueId, mode, symbol: issue.symbol!, pos: issue.pos, parentSymbol: issue.parentSymbol });
    sourceOpsByFile.set(issue.filePath, list);
  }

  // delete-file wins over any other patch for the same file: drop queued
  // source ops for that file (marking their issues ok:true — the underlying
  // problem is resolved by the file's removal) before producing the delete patch.
  for (const [filePath, fileIssueIds] of deleteFileIssuesByFile) {
    const superseded = sourceOpsByFile.get(filePath);
    if (superseded) {
      sourceOpsByFile.delete(filePath);
      for (const id of new Set(superseded.map((op) => op.issueId))) items.push({ issueId: id, ok: true, filePath });
    }

    const abs = resolve(projectDir, filePath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const id of fileIssueIds) items.push({ issueId: id, ok: false, reason: 'file-not-found', filePath });
      continue;
    }
    const patch: FilePatch = { filePath, kind: 'delete', hashBefore: hashContent(contentBefore), contentAfter: null };
    patches.push(patch);
    diffs.push({ filePath, diff: renderDiff(patch, contentBefore) });
    for (const id of fileIssueIds) items.push({ issueId: id, ok: true, filePath });
  }

  for (const [filePath, ops] of sourceOpsByFile) {
    const abs = resolve(projectDir, filePath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const id of new Set(ops.map((op) => op.issueId))) {
        items.push({ issueId: id, ok: false, reason: 'file-not-found', filePath });
      }
      continue;
    }

    const { content, changed, items: chainItems } = runSourceChain(filePath, contentBefore, ops);
    items.push(...chainItems);

    if (changed) {
      const patch: FilePatch = { filePath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: content };
      patches.push(patch);
      diffs.push({ filePath, diff: renderDiff(patch, contentBefore) });
    }
  }

  for (const [pkgPath, ops] of depOpsByPkg) {
    const abs = resolve(projectDir, pkgPath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const op of ops) items.push({ issueId: op.issueId, ok: false, reason: 'file-not-found', filePath: pkgPath });
      continue;
    }

    let current = contentBefore;
    let changed = false;
    for (const op of ops) {
      const result = removeDependency(current, op.depName, op.issueType);
      if (result.ok) {
        if (result.newContent !== current) changed = true;
        current = result.newContent;
        items.push({ issueId: op.issueId, ok: true, filePath: pkgPath });
      } else {
        items.push({ issueId: op.issueId, ok: false, reason: result.reason, filePath: pkgPath });
      }
    }

    if (changed) {
      const patch: FilePatch = { filePath: pkgPath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: current };
      patches.push(patch);
      diffs.push({ filePath: pkgPath, diff: renderDiff(patch, contentBefore) });
    }
  }

  return { planId: newPlanId(), kind: 'fix', patches, diffs, items, createdAt: new Date().toISOString() };
}
