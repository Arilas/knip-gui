import { join, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { FixMode, Issue } from '../core/types.js';
import { renderDiff } from './diff.js';
import { hashContent, type FilePatch } from './patch.js';
import { chainTextEdits, newPlanId, readFileOrNull, type FixPlan, type PlanItem } from './plan.js';
import { deleteDeclarationBatch } from './transforms/delete-declaration.js';
import { removeDependency, type PackageJsonIssueType } from './transforms/package-json.js';
import { removeDuplicateBatch } from './transforms/remove-duplicate.js';
import { removeMemberBatch } from './transforms/remove-member.js';
import {
  applyEdits,
  parseSource,
  type BatchOpResult,
  type ParsedSource,
  type SourceBatchResult,
  type SourceEdit,
  type SourceOp,
} from './transforms/source.js';
import { stripExportBatch } from './transforms/strip-export.js';

export interface FixSelection {
  issueIds: string[];
  modeOverrides?: Record<string, FixMode>; // default mode = issue.fixModes[0]
}

// --- fix plan ---

const CONFLICT_REASON = 'conflicts with another selected fix in the same statement';

// Fixed processing order = the determinism guarantee of the conflict rule.
const SOURCE_MODE_ORDER = ['strip-export', 'delete-declaration', 'remove-duplicate', 'remove-member'] as const;
type SourceMode = (typeof SOURCE_MODE_ORDER)[number];

const BATCH_BY_MODE: Record<
  SourceMode,
  (parsed: ParsedSource, content: string, ops: readonly SourceOp[]) => SourceBatchResult
> = {
  'strip-export': stripExportBatch,
  'delete-declaration': deleteDeclarationBatch,
  'remove-duplicate': removeDuplicateBatch,
  'remove-member': removeMemberBatch,
};

interface CompilerSourceOp extends SourceOp {
  issueId: string;
  mode: SourceMode;
}

// Half-open [start,end): touching ranges do NOT overlap — adjacent
// list-item removals from one coordinated batch legitimately touch.
function overlapsAny(edit: SourceEdit, accepted: readonly SourceEdit[]): boolean {
  return accepted.some((a) => a.start < edit.end && edit.start < a.end);
}

// Compiles ALL of one file's source ops against ONE parse: group by mode
// (fixed order), run each mode's batch function, merge edits under the
// conflict rule, apply once. Every op locates against the ORIGINAL
// content with its own `pos` — no op-to-op content threading.
function compileSourceFile(
  filePath: string,
  content: string,
  ops: CompilerSourceOp[],
): { content: string; changed: boolean; items: PlanItem[] } {
  const parsed = parseSource(filePath, content);
  const acceptedEdits: SourceEdit[] = [];
  const resultsByIssue = new Map<string, BatchOpResult[]>();

  for (const mode of SOURCE_MODE_ORDER) {
    const modeOps = ops.filter((op) => op.mode === mode);
    if (modeOps.length === 0) continue;
    const { results, edits } = BATCH_BY_MODE[mode](parsed, content, modeOps);

    // Conflict rule: an edit overlapping an already-accepted edit (from
    // an earlier mode) fails every op that produced it...
    const failed = new Set<number>();
    for (const edit of edits) {
      if (overlapsAny(edit, acceptedEdits)) for (const owner of edit.owners) failed.add(owner);
    }
    // ...and a failed op's OTHER edits are dropped too. Dropping a shared
    // (multi-owner) edit would leave its co-owners half-applied, so the
    // failure propagates across shared edits to a fixpoint.
    let grew = true;
    while (grew) {
      grew = false;
      for (const edit of edits) {
        if (!edit.owners.some((owner) => failed.has(owner))) continue;
        for (const owner of edit.owners) {
          if (!failed.has(owner)) {
            failed.add(owner);
            grew = true;
          }
        }
      }
    }

    modeOps.forEach((op, i) => {
      const result = results[i]!;
      // A locate failure keeps its own reason; only ok ops downgraded by
      // the conflict rule get the conflict reason.
      const finalResult: BatchOpResult =
        result.ok && failed.has(i) ? { ok: false, reason: CONFLICT_REASON } : result;
      const list = resultsByIssue.get(op.issueId) ?? [];
      list.push(finalResult);
      resultsByIssue.set(op.issueId, list);
    });
    for (const edit of edits) {
      if (!edit.owners.some((owner) => failed.has(owner))) acceptedEdits.push(edit);
    }
  }

  // Multiple ops can share one issueId (a `duplicates` issue explodes into
  // one op per alias) — the issue is ok:true only if ALL its ops succeeded.
  const items: PlanItem[] = [];
  for (const [issueId, results] of resultsByIssue) {
    const failedResult = results.find((r): r is { ok: false; reason: string } => !r.ok);
    items.push(
      failedResult
        ? { issueId, ok: false, reason: failedResult.reason, filePath }
        : { issueId, ok: true, filePath },
    );
  }

  const newContent = acceptedEdits.length > 0 ? applyEdits(content, acceptedEdits) : content;
  return { content: newContent, changed: newContent !== content, items };
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

  const sourceOpsByFile = new Map<string, CompilerSourceOp[]>();
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
      for (const m of members) list.push({ issueId, mode: mode as SourceMode, symbol: m.symbol, pos: m.pos });
      sourceOpsByFile.set(issue.filePath, list);
      continue;
    }

    // strip-export | delete-declaration | remove-member
    const list = sourceOpsByFile.get(issue.filePath) ?? [];
    list.push({
      issueId,
      mode: mode as SourceMode,
      symbol: issue.symbol!,
      pos: issue.pos,
      parentSymbol: issue.parentSymbol,
    });
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

  const sourceEntries = [...sourceOpsByFile];
  const sourceContents = await Promise.all(
    sourceEntries.map(([filePath]) => readFileOrNull(resolve(projectDir, filePath))),
  );
  for (let fileIndex = 0; fileIndex < sourceEntries.length; fileIndex++) {
    const [filePath, ops] = sourceEntries[fileIndex]!;
    const contentBefore = sourceContents[fileIndex]!;
    if (contentBefore === null) {
      for (const id of new Set(ops.map((op) => op.issueId))) {
        items.push({ issueId: id, ok: false, reason: 'file-not-found', filePath });
      }
      continue;
    }
    // Parsing + applying is synchronous per file; yield between files so a
    // "select all" over many files can't stall the event loop.
    if (fileIndex > 0) await yieldToEventLoop();

    const { content, changed, items: fileItems } = compileSourceFile(filePath, contentBefore, ops);
    items.push(...fileItems);

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

    const { content: current, changed, results } = chainTextEdits(contentBefore, ops, (text, op) =>
      removeDependency(text, op.depName, op.issueType),
    );
    ops.forEach((op, i) => {
      const result = results[i]!;
      items.push(
        result.ok
          ? { issueId: op.issueId, ok: true, filePath: pkgPath }
          : { issueId: op.issueId, ok: false, reason: result.reason, filePath: pkgPath },
      );
    });

    if (changed) {
      const patch: FilePatch = { filePath: pkgPath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: current };
      patches.push(patch);
      diffs.push({ filePath: pkgPath, diff: renderDiff(patch, contentBefore) });
    }
  }

  return { planId: newPlanId(), kind: 'fix', patches, diffs, items, createdAt: new Date().toISOString() };
}
