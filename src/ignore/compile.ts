import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { IGNORABLE_ISSUE_TYPES, type Issue } from '../core/types.js';
import { renderDiff } from '../fix/diff.js';
import { hashContent, type FilePatch } from '../fix/patch.js';
import { newPlanId, readFileOrNull, type FixPlan, type PlanItem } from '../fix/plan.js';
import type { TransformInput } from '../fix/transforms/source.js';
import {
  addIgnores,
  findKnipConfig,
  removeIgnores,
  type IgnoreEdit,
  type IgnoreEntry,
  type KnipConfigKind,
} from './config-writer.js';
import { insertMemberPublicTag, insertPublicTag } from './public-tag.js';

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

    // Ignorability is decided by the shared IGNORABLE_ISSUE_TYPES set (also used
    // by the client's isIgnorable) — the switch below only ever needs cases for
    // types this guard admits; the `default` is an unreachable safety net.
    if (!IGNORABLE_ISSUE_TYPES.has(issue.type)) {
      items.push({ issueId, ok: false, reason: 'not-ignorable', filePath: issue.filePath });
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
        items.push({ issueId, ok: false, reason: 'not-ignorable', filePath: issue.filePath });
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
      const relPath = relative(projectDir, abs);
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
          items.push({ issueId, ok: true, filePath: relPath });
        } else {
          items.push({ issueId, ok: false, reason: result.reason, filePath: relPath });
        }
      }
      if (changed) {
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
      for (const op of ops) items.push({ issueId: op.issueId, ok: false, reason: 'file-not-found', filePath });
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
        items.push({ issueId: op.issueId, ok: true, filePath });
      } else {
        items.push({ issueId: op.issueId, ok: false, reason: result.reason, filePath });
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
      const relPath = relative(projectDir, abs);
      const contentBefore = await readFile(abs, 'utf8');
      const result = removeIgnores(contentBefore, configKind, entries);

      if (!result.ok) {
        for (const entry of entries) {
          items.push({ issueId: ignoreEntryId(entry), ok: false, reason: result.reason, filePath: relPath });
        }
      } else {
        for (const entry of entries) items.push({ issueId: ignoreEntryId(entry), ok: true, filePath: relPath });
        if (result.newContent !== contentBefore) {
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
