import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { FixMode, Issue } from '../core/types.js';
import {
  addIgnores,
  findKnipConfig,
  removeIgnores,
  type IgnoreEdit,
  type IgnoreEntry,
  type KnipConfigKind,
} from '../ignore/config-writer.js';
import { insertMemberPublicTag, insertPublicTag } from '../ignore/public-tag.js';
import { renderDiff } from './diff.js';
import { hashContent, type FilePatch } from './patch.js';
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

export interface PlanItem {
  issueId: string;
  ok: boolean;
  reason?: string;
}

export interface FixPlan {
  planId: string; // random hex
  kind: 'fix' | 'ignore' | 'ignore-remove';
  patches: FilePatch[];
  diffs: { filePath: string; diff: string }[];
  items: PlanItem[]; // per-issue compile outcome (transform failures land here)
  createdAt: string;
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function newPlanId(): string {
  return randomBytes(16).toString('hex');
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
    items.push(failed ? { issueId, ok: false, reason: failed.reason } : { issueId, ok: true });
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
      items.push({ issueId, ok: false, reason: 'not-fixable' });
      continue;
    }
    const mode = selection.modeOverrides?.[issueId] ?? issue.fixModes[0]!;
    if (!issue.fixModes.includes(mode)) {
      items.push({ issueId, ok: false, reason: 'invalid-mode' });
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
        items.push({ issueId, ok: false, reason: 'no-duplicate-members' });
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
      for (const id of new Set(superseded.map((op) => op.issueId))) items.push({ issueId: id, ok: true });
    }

    const abs = resolve(projectDir, filePath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const id of fileIssueIds) items.push({ issueId: id, ok: false, reason: 'file-not-found' });
      continue;
    }
    const patch: FilePatch = { filePath, kind: 'delete', hashBefore: hashContent(contentBefore), contentAfter: null };
    patches.push(patch);
    diffs.push({ filePath, diff: renderDiff(patch, contentBefore) });
    for (const id of fileIssueIds) items.push({ issueId: id, ok: true });
  }

  for (const [filePath, ops] of sourceOpsByFile) {
    const abs = resolve(projectDir, filePath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const id of new Set(ops.map((op) => op.issueId))) {
        items.push({ issueId: id, ok: false, reason: 'file-not-found' });
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
      for (const op of ops) items.push({ issueId: op.issueId, ok: false, reason: 'file-not-found' });
      continue;
    }

    let current = contentBefore;
    let changed = false;
    for (const op of ops) {
      const result = removeDependency(current, op.depName, op.issueType);
      if (result.ok) {
        if (result.newContent !== current) changed = true;
        current = result.newContent;
        items.push({ issueId: op.issueId, ok: true });
      } else {
        items.push({ issueId: op.issueId, ok: false, reason: result.reason });
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

// --- ignore plan ---

// `issue.filePath` is project-root relative (knip's own convention); knip's
// per-workspace `ignore` glob patterns are relative to that workspace's own
// directory (mirroring how `entry`/`project` patterns work), so a workspace-
// scoped file-ignore value must have the workspace prefix stripped.
function relativeToWorkspace(filePath: string, workspace: string): string {
  if (workspace === '.') return filePath;
  const prefix = `${workspace}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export async function compileIgnorePlan(
  projectDir: string,
  issues: Issue[],
  issueIds: string[],
): Promise<FixPlan> {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const items: PlanItem[] = [];
  const patches: FilePatch[] = [];
  const diffs: { filePath: string; diff: string }[] = [];

  const configEdits: { issueId: string; edit: IgnoreEdit }[] = [];
  interface TagOp {
    issueId: string;
    symbol: string;
    pos?: number;
    // Set for enumMembers/namespaceMembers ops: tag the MEMBER named `symbol`
    // inside this parent via insertMemberPublicTag (top-level ops leave it
    // unset and go through insertPublicTag).
    parentSymbol?: string;
  }
  const tagOpsByFile = new Map<string, TagOp[]>();

  for (const issueId of issueIds) {
    const issue = issueById.get(issueId);
    if (!issue) {
      items.push({ issueId, ok: false, reason: 'unknown-issue' });
      continue;
    }

    switch (issue.type) {
      case 'files': {
        const value = relativeToWorkspace(issue.filePath, issue.workspace);
        configEdits.push({ issueId, edit: { kind: 'ignore', value, workspace: issue.workspace } });
        break;
      }
      case 'dependencies':
      case 'devDependencies':
      case 'optionalPeerDependencies':
        configEdits.push({
          issueId,
          edit: { kind: 'ignoreDependencies', value: issue.symbol!, workspace: issue.workspace },
        });
        break;
      case 'binaries':
        configEdits.push({
          issueId,
          edit: { kind: 'ignoreBinaries', value: issue.symbol!, workspace: issue.workspace },
        });
        break;
      case 'exports':
      case 'types': {
        const list = tagOpsByFile.get(issue.filePath) ?? [];
        list.push({ issueId, symbol: issue.symbol!, pos: issue.pos });
        tagOpsByFile.set(issue.filePath, list);
        break;
      }
      case 'enumMembers':
      case 'namespaceMembers': {
        // Tag the MEMBER's own line, never the parent declaration: knip reads
        // jsDocTags at the member's own position, and a parent-level @public
        // would over-suppress by silencing ALL of the enum's/namespace's
        // members (verified live against knip's analyze pass). `issue.pos` is
        // the member's own position and is exactly what
        // insertMemberPublicTag's locator expects (a same-name tiebreak).
        const list = tagOpsByFile.get(issue.filePath) ?? [];
        list.push({ issueId, symbol: issue.symbol!, pos: issue.pos, parentSymbol: issue.parentSymbol! });
        tagOpsByFile.set(issue.filePath, list);
        break;
      }
      default:
        // unlisted, unresolved, duplicates, nsExports, nsTypes, catalog, cycles
        items.push({ issueId, ok: false, reason: 'not-ignorable' });
    }
  }

  if (configEdits.length > 0) {
    const config = findKnipConfig(projectDir);
    if (config.kind === 'code') {
      for (const { issueId } of configEdits) items.push({ issueId, ok: false, reason: 'code-config' });
    } else if (config.kind === 'none') {
      for (const { issueId } of configEdits) items.push({ issueId, ok: false, reason: 'no-config' });
    } else {
      const configKind = config.kind as Exclude<KnipConfigKind, 'code' | 'none'>;
      const abs = config.path!;
      const contentBefore = await readFile(abs, 'utf8');
      let current = contentBefore;
      let changed = false;
      // Applied one edit at a time (rather than one addIgnores call with the
      // whole batch) so a single bad edit — e.g. a workspace's `ignore` key
      // already holding a non-array value — fails only its own issue and
      // doesn't discard edits that already succeeded earlier in the batch.
      for (const { issueId, edit } of configEdits) {
        const result = addIgnores(current, configKind, [edit]);
        if (result.ok) {
          if (result.newContent !== current) changed = true;
          current = result.newContent;
          items.push({ issueId, ok: true });
        } else {
          items.push({ issueId, ok: false, reason: result.reason });
        }
      }
      if (changed) {
        const relPath = relative(projectDir, abs);
        const patch: FilePatch = { filePath: relPath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: current };
        patches.push(patch);
        diffs.push({ filePath: relPath, diff: renderDiff(patch, contentBefore) });
      }
    }
  }

  for (const [filePath, ops] of tagOpsByFile) {
    const abs = resolve(projectDir, filePath);
    const contentBefore = await readFileOrNull(abs);
    if (contentBefore === null) {
      for (const op of ops) items.push({ issueId: op.issueId, ok: false, reason: 'file-not-found' });
      continue;
    }

    const sorted = [...ops].sort((a, b) => (b.pos ?? -1) - (a.pos ?? -1));
    let current = contentBefore;
    let changed = false;
    sorted.forEach((op, idx) => {
      const input: TransformInput = {
        filePath,
        content: current,
        symbol: op.symbol,
        pos: idx === 0 ? op.pos : undefined,
      };
      const result = op.parentSymbol !== undefined
        ? insertMemberPublicTag({ ...input, parentSymbol: op.parentSymbol })
        : insertPublicTag(input);
      if (result.ok) {
        if (result.newContent !== current) changed = true;
        current = result.newContent;
        items.push({ issueId: op.issueId, ok: true });
      } else {
        items.push({ issueId: op.issueId, ok: false, reason: result.reason });
      }
    });

    if (changed) {
      const patch: FilePatch = { filePath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: current };
      patches.push(patch);
      diffs.push({ filePath, diff: renderDiff(patch, contentBefore) });
    }
  }

  return { planId: newPlanId(), kind: 'ignore', patches, diffs, items, createdAt: new Date().toISOString() };
}

// --- remove-ignores plan (Task 5, Ignored page) ---

// A synthetic per-entry id — these entries come from listIgnores' parse of
// the config file, not from a scanned Issue, so there's no existing issueId
// to reuse. Stable across preview/apply for the SAME entry (kind+workspace+
// value uniquely identifies one array slot), which is all PlanItem needs it
// for: matching a compile outcome back to the entry that produced it.
function ignoreEntryId(entry: IgnoreEntry): string {
  return `${entry.kind}:${entry.workspace ?? '.'}:${entry.value}`;
}

// Compiles a plan that removes the given (already-present) ignore entries
// from the project's knip config — the inverse of compileIgnorePlan's
// config-edit half, for the Ignored page's per-entry Remove action. Unlike
// compileIgnorePlan/compileFixPlan (which apply one compile-time op per issue
// and can partially succeed across issues), removeIgnores itself is an atomic
// batch call (see its own doc comment): either every listed entry is found
// and removed, or the whole call fails and every entry's PlanItem reports the
// same failure reason — there's no per-entry partial-success story to report
// here because there's no way to know WHICH entry failed once removeIgnores
// itself only exposes "not-found" for the whole call.
export async function compileRemoveIgnoresPlan(projectDir: string, entries: IgnoreEntry[]): Promise<FixPlan> {
  const items: PlanItem[] = [];
  const patches: FilePatch[] = [];
  const diffs: { filePath: string; diff: string }[] = [];

  if (entries.length > 0) {
    const config = findKnipConfig(projectDir);
    if (config.kind === 'code' || config.kind === 'none') {
      const reason = config.kind === 'code' ? 'code-config' : 'no-config';
      for (const entry of entries) items.push({ issueId: ignoreEntryId(entry), ok: false, reason });
    } else {
      const configKind = config.kind as Exclude<KnipConfigKind, 'code' | 'none'>;
      const abs = config.path!;
      const contentBefore = await readFile(abs, 'utf8');
      const result = removeIgnores(contentBefore, configKind, entries);

      if (!result.ok) {
        for (const entry of entries) items.push({ issueId: ignoreEntryId(entry), ok: false, reason: result.reason });
      } else {
        for (const entry of entries) items.push({ issueId: ignoreEntryId(entry), ok: true });
        if (result.newContent !== contentBefore) {
          const relPath = relative(projectDir, abs);
          const patch: FilePatch = {
            filePath: relPath,
            kind: 'modify',
            hashBefore: hashContent(contentBefore),
            contentAfter: result.newContent,
          };
          patches.push(patch);
          diffs.push({ filePath: relPath, diff: renderDiff(patch, contentBefore) });
        }
      }
    }
  }

  return { planId: newPlanId(), kind: 'ignore-remove', patches, diffs, items, createdAt: new Date().toISOString() };
}
