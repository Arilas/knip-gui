# Compiler-Shape Batch Implementation Plan (#32, #42)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fix-plan/ignore-plan compilation parse each source file ONCE per compile (instead of once per issue), applying all of a file's edits through a single MagicString, while relocating plan primitives to `src/fix/plan.ts` and ignore-plan compilation to `src/ignore/compile.ts`.

**Architecture:** Every source transform gains a *batch* function that receives one `ParsedSource` + the original content + ALL of that file's ops for its mode, and returns per-op results plus `SourceEdit`s computed against original offsets; the old single-op functions become thin wrappers over the batch functions (the regression harness). The compiler groups ops per file by mode, calls each mode's batch function against one shared parse, merges edits under a deterministic cross-mode conflict rule, and applies them in one `MagicString.toString()`. Structural moves reverse the `fix → ignore` dependency arrow: `src/ignore/compile.ts` depends only on `src/fix/plan.ts` primitives.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), oxc-parser 0.137.x, magic-string, vitest, pnpm 10.

## Global Constraints

- **Package manager: pnpm 10** (pnpm 11 is forbidden with Node 20). All commands run through pnpm: `pnpm test`, `pnpm test <file>`, `pnpm run typecheck`.
- **Every existing test must pass UNCHANGED through the single-op wrappers — a failing existing test means the refactor is wrong, not the test.** The ONLY exception: import-path lines in the four test files touched by the Task 1 structural relocations (`tests/unit/compiler.test.ts`, `tests/unit/plan-store.test.ts`, `tests/integration/ignore-roundtrip.test.ts`, `tests/client/apply-flow.test.ts`). Assertions are never edited.
- **Every op uses its own original `pos`.** The old "only idx===0 gets pos" chaining rule disappears: all ops locate against the ORIGINAL bytes, which is exactly what knip measured `pos` against.
- **Conflict rule reason string, exactly:** `'conflicts with another selected fix in the same statement'`.
- **`PlanItem.filePath` semantics unchanged** (the #39 contract documented on the interface): set for every item except unknown-issue and no/code-config ignore failures.
- **No back-compat re-exports** anywhere (knip dogfooding would flag them). Importers are updated to the new module paths instead.
- **Run `pnpm run typecheck` before every commit.**
- Non-goals (do not touch): preview/apply wire shapes, `PlanStore`, routes, worker threads, batched `addIgnores` (#36).
- This plan is executed on a feature branch, task by task, one commit per task (Task 1 and Task 6 have the listed extra verification steps before committing).

---

## Task 1: Structural moves (#42) — pure relocation, zero behavior change

**Files**
- Create: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/plan.ts`
- Create: `/Volumes/Dev/Projects/krona/knip-gui/src/ignore/compile.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/compiler.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/plan-store.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/api-types.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/routes-fix.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/routes-ignores.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/api.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/lib/apply-flow.ts`
- Test (imports only): `tests/unit/compiler.test.ts`, `tests/unit/plan-store.test.ts`, `tests/integration/ignore-roundtrip.test.ts`, `tests/client/apply-flow.test.ts`

**Interfaces**
- Produces `src/fix/plan.ts`:
  - `export interface PlanItem { issueId: string; ok: boolean; reason?: string; filePath?: string }` (with its full doc comment, verbatim)
  - `export interface FixPlan { planId: string; kind: 'fix' | 'ignore' | 'ignore-remove'; patches: FilePatch[]; diffs: { filePath: string; diff: string }[]; items: PlanItem[]; createdAt: string }`
  - `export async function readFileOrNull(absPath: string): Promise<string | null>`
  - `export function newPlanId(): string`
- Produces `src/ignore/compile.ts`:
  - `export async function compileIgnorePlan(projectDir: string, issues: Issue[], issueIds: string[]): Promise<FixPlan>`
  - `export async function compileRemoveIgnoresPlan(projectDir: string, entries: IgnoreEntry[]): Promise<FixPlan>`
- `src/fix/compiler.ts` keeps: `FixSelection`, `compileFixPlan` (both exported, signatures unchanged).

### Steps

- [ ] **Create `src/fix/plan.ts`.** Content: header imports

  ```ts
  import { randomBytes } from 'node:crypto';
  import { readFile } from 'node:fs/promises';
  import type { FilePatch } from './patch.js';
  ```

  then move, verbatim (including doc comments), from `src/fix/compiler.ts`:
  - lines 28–41 (`export interface PlanItem { ... }`)
  - lines 43–50 (`export interface FixPlan { ... }`)
  - lines 52–59 (`async function readFileOrNull`), adding the `export` keyword
  - lines 61–63 (`function newPlanId`), adding the `export` keyword

- [ ] **Create `src/ignore/compile.ts`.** Header imports:

  ```ts
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
  ```

  then move, verbatim, `src/fix/compiler.ts` lines 292–521: the entire `// --- ignore plan ---` and `// --- remove-ignores plan ---` sections (`relativeToWorkspace`, `compileIgnorePlan`, `ignoreEntryId`, `compileRemoveIgnoresPlan`, with all comments). No code edits beyond what the new import block already covers.

- [ ] **Shrink `src/fix/compiler.ts`.** Delete the moved lines (28–63 plan primitives, 292–521 ignore section). Delete the now-unused imports: the whole `../ignore/config-writer.js` import, the `../ignore/public-tag.js` import, `randomBytes`, `readFile`, `relative`, and `IGNORABLE_ISSUE_TYPES` (keep `join`, `resolve`, `FixMode`, `Issue`). Add:

  ```ts
  import { newPlanId, readFileOrNull, type FixPlan, type PlanItem } from './plan.js';
  ```

  `FixSelection`, the `// --- fix plan ---` section, `runSourceTransform`, `runSourceChain`, and `compileFixPlan` stay byte-identical. No re-export of the moved names.

- [ ] **Update importers** (exact line edits):
  - `src/fix/plan-store.ts:1` → `import type { FixPlan } from './plan.js';`
  - `src/server/api-types.ts:7` → `import type { FixPlan, PlanItem } from '../fix/plan.js';`
  - `src/server/routes-fix.ts:3` → split into `import { compileFixPlan } from '../fix/compiler.js';` and `import { compileIgnorePlan } from '../ignore/compile.js';`
  - `src/server/routes-ignores.ts:2` → `import { compileRemoveIgnoresPlan } from '../ignore/compile.js';`
  - `client/src/api.ts:17` → `import type { PlanItem } from '../../src/fix/plan.js';`
  - `client/src/lib/apply-flow.ts:12` → `import type { PlanItem } from '../../../src/fix/plan.js';`
  - `tests/unit/compiler.test.ts:7` → `import { compileFixPlan, type FixSelection } from '../../src/fix/compiler.js';` plus a new line `import { compileIgnorePlan } from '../../src/ignore/compile.js';`
  - `tests/unit/plan-store.test.ts:3` → `import type { FixPlan } from '../../src/fix/plan.js';`
  - `tests/integration/ignore-roundtrip.test.ts:9` → `import { compileIgnorePlan } from '../../src/ignore/compile.js';`
  - `tests/client/apply-flow.test.ts:8` → `import type { PlanItem } from '../../src/fix/plan.js';`

- [ ] Run `pnpm test` — expected: entire suite passes, zero assertion changes.
- [ ] Run `pnpm run typecheck` — expected: clean (all three tsconfigs).
- [ ] Sanity grep: `grep -rn "fix/compiler.js" src client tests` must show only `compileFixPlan`/`FixSelection` consumers (`routes-fix.ts`, `compiler.test.ts`).
- [ ] Commit: `refactor: move plan primitives to fix/plan.ts and ignore-plan compilation to ignore/compile.ts (#42)`

---

## Task 2: Batch contract in source.ts + stripExportBatch

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/source.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/strip-export.ts`
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/batch-strip-export.test.ts`

**Interfaces**
- Consumes (already in source.ts): `parseSource`, `locateExport`, `findExportedFunctionSites`, `ExportSite`, `Span`, `ParsedSource`, `TransformInput`, `TransformResult`.
- Produces (source.ts — every later task consumes exactly these):

  ```ts
  /** A removal ([start,end) deleted), an insertion (start===end, text added),
   *  or a replacement (start<end with text — applied as an overwrite; needed
   *  for the public-tag single-line-JSDoc expansion). */
  export interface SourceEdit { start: number; end: number; text?: string }
  export type BatchOpResult = { ok: true } | { ok: false; reason: string };
  /** One transform op, compiler-agnostic (no issueId/mode). */
  export interface SourceOp { symbol: string; pos?: number; parentSymbol?: string }
  /** An edit plus the indices (into the batch's `ops`) of the op(s) that produced it. */
  export interface BatchEdit extends SourceEdit { owners: number[] }
  export interface SourceBatchResult { results: BatchOpResult[]; edits: BatchEdit[] }

  export function pushEdit(edits: BatchEdit[], edit: SourceEdit, owners: readonly number[]): void
  export function applyEdits(content: string, edits: readonly SourceEdit[]): string
  export function removeListItems(items: readonly Span[], sortedIndices: readonly number[]): (SourceEdit & { itemIndices: number[] })[]
  export function applySingleOp(filePath: string, content: string, op: SourceOp, batchFn: (parsed: ParsedSource, content: string, ops: readonly SourceOp[]) => SourceBatchResult): TransformResult
  ```

- Produces (strip-export.ts):

  ```ts
  export function stripExportBatch(parsed: ParsedSource, _content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function stripExport(input: TransformInput): TransformResult  // unchanged signature, now a wrapper
  ```

### Steps

- [ ] **Write the failing test.** Create `tests/unit/batch-strip-export.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { stripExportBatch } from '../../src/fix/transforms/strip-export.js';
  import {
    applyEdits,
    parseSource,
    removeListItems,
    type SourceOp,
  } from '../../src/fix/transforms/source.js';

  function run(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = stripExportBatch(parsed, content, ops);
    return { results, out: applyEdits(content, edits) };
  }

  describe('removeListItems: generalized comma hygiene', () => {
    // spans of 'a', 'b', 'c' in the string 'a, b, c'
    const items = [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
      { start: 6, end: 7 },
    ];

    it('single non-last index removes through the next item start', () => {
      expect(removeListItems(items, [1])).toEqual([{ start: 3, end: 6, itemIndices: [1] }]);
    });

    it('single last index removes from the previous survivor end', () => {
      expect(removeListItems(items, [2])).toEqual([{ start: 4, end: 7, itemIndices: [2] }]);
    });

    it('non-adjacent subset: one edit per non-trailing item plus a trailing-run edit', () => {
      expect(removeListItems(items, [0, 2])).toEqual([
        { start: 0, end: 3, itemIndices: [0] },
        { start: 4, end: 7, itemIndices: [2] },
      ]);
    });

    it('a trailing run collapses into a single edit owned by every removed item', () => {
      expect(removeListItems(items, [1, 2])).toEqual([{ start: 1, end: 7, itemIndices: [1, 2] }]);
    });
  });

  describe('stripExportBatch: multiple ops, one parse', () => {
    it('strips two declarations, each op using its own original pos', () => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('const a = 1;\nconst b = 2;\n');
    });

    it('removes a subset of an export list with comma hygiene (first + last)', () => {
      const content =
        'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nexport { a, b, c };\n';
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a, b') },
        { symbol: 'c', pos: content.indexOf('c }') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe(
        'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nexport { b };\n',
      );
    });

    it('removes an adjacent middle run from a re-export list', () => {
      const content = "export { a, b, c, d } from './m.js';\n";
      const { results, out } = run(content, [
        { symbol: 'b', pos: content.indexOf('b,') },
        { symbol: 'c', pos: content.indexOf('c,') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe("export { a, d } from './m.js';\n");
    });

    it('ops that together empty a list remove the whole statement', () => {
      const content = "export { a, b } from './m.js';\n";
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a,') },
        { symbol: 'b', pos: content.indexOf('b }') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('\n');
    });

    it('two declarator ops on one multi-declarator statement dedupe into one unexport', () => {
      const content = 'export const a = 1, b = 2;\n';
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('const a = 1, b = 2;\n');
    });

    it('a failing op does not disturb its neighbors', () => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      const { results, out } = run(content, [
        { symbol: 'nope', pos: 999 },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results[0]).toEqual({ ok: false, reason: 'no export found at position 999' });
      expect(results[1]).toEqual({ ok: true });
      expect(out).toBe('export const a = 1;\nconst b = 2;\n');
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/batch-strip-export.test.ts` — expected: FAIL (unresolved exports `stripExportBatch`, `applyEdits`, `removeListItems`, `SourceOp`).

- [ ] **Implement the source.ts additions.** In `src/fix/transforms/source.ts`:
  1. Change line 10 from `import type MagicString from 'magic-string';` to `import MagicString from 'magic-string';` (value import — `applyEdits` constructs one; the existing `removeListItem` type usage keeps compiling).
  2. Add, directly below the `TransformResult` type (line 20), the four types from the Interfaces block above (`SourceEdit`, `BatchOpResult`, `SourceOp`, `BatchEdit`, `SourceBatchResult`) with their doc comments.
  3. Add, directly below `removeListItem` (line 359), these three helpers, complete:

  ```ts
  // Generalizes removeListItem to a batch of removed indices from one
  // comma-separated list, computed against ORIGINAL offsets. Comma hygiene:
  // each removed item with a surviving successor removes [cur.start,
  // next.start); a run of removed items at the END of the list collapses into
  // ONE edit [lastSurvivor.end, lastRemoved.end) so the edits never overlap.
  // Precondition: sortedIndices is ascending, non-empty, and a STRICT subset
  // of items — callers turn the all-items case into a whole-statement removal.
  export function removeListItems(
    items: readonly Span[],
    sortedIndices: readonly number[],
  ): (SourceEdit & { itemIndices: number[] })[] {
    const removed = new Set(sortedIndices);
    let firstTrailing = items.length;
    while (firstTrailing > 0 && removed.has(firstTrailing - 1)) firstTrailing--;
    const edits: (SourceEdit & { itemIndices: number[] })[] = [];
    for (const index of sortedIndices) {
      if (index >= firstTrailing) continue; // folded into the trailing-run edit below
      edits.push({ start: items[index]!.start, end: items[index + 1]!.start, itemIndices: [index] });
    }
    if (firstTrailing < items.length) {
      const lastSurvivor = items[firstTrailing - 1]!; // exists: strict subset
      const lastRemoved = items[items.length - 1]!;
      edits.push({
        start: lastSurvivor.end,
        end: lastRemoved.end,
        itemIndices: sortedIndices.filter((i) => i >= firstTrailing),
      });
    }
    return edits;
  }

  // Appends an edit, deduping byte-identical edits onto shared owners. Two ops
  // can legitimately compute the SAME edit (both declarators of one statement
  // being strip-exported; two export-list bindings deleting one shared local
  // declaration; two tag ops resolving to one anchor) — one edit, all owners.
  export function pushEdit(edits: BatchEdit[], edit: SourceEdit, owners: readonly number[]): void {
    const existing = edits.find((e) => e.start === edit.start && e.end === edit.end && e.text === edit.text);
    if (existing) {
      for (const owner of owners) if (!existing.owners.includes(owner)) existing.owners.push(owner);
      return;
    }
    const next: BatchEdit = { start: edit.start, end: edit.end, owners: [...owners] };
    if (edit.text !== undefined) next.text = edit.text;
    edits.push(next);
  }

  // Applies a set of non-overlapping edits to one MagicString: removal
  // (no text), insertion (start===end), or replacement (start<end + text).
  // Callers guarantee non-overlap (batch coordination + the compiler's
  // conflict rule) — magic-string is never handed overlapping removals.
  export function applyEdits(content: string, edits: readonly SourceEdit[]): string {
    const s = new MagicString(content);
    for (const edit of edits) {
      if (edit.text !== undefined && edit.start < edit.end) s.overwrite(edit.start, edit.end, edit.text);
      else if (edit.text !== undefined) s.appendLeft(edit.start, edit.text);
      else s.remove(edit.start, edit.end);
    }
    return s.toString();
  }

  // Adapts a batch transform to the legacy one-op TransformResult contract:
  // parse, run the batch with a single op, apply its edits. The entire
  // pre-batch test suite runs through this wrapper — it is the regression
  // harness proving the batch functions reproduce single-op behavior exactly.
  export function applySingleOp(
    filePath: string,
    content: string,
    op: SourceOp,
    batchFn: (parsed: ParsedSource, content: string, ops: readonly SourceOp[]) => SourceBatchResult,
  ): TransformResult {
    const parsed = parseSource(filePath, content);
    const { results, edits } = batchFn(parsed, content, [op]);
    const first = results[0]!;
    if (!first.ok) return first;
    return { ok: true, newContent: applyEdits(content, edits) };
  }
  ```

- [ ] **Rewrite `src/fix/transforms/strip-export.ts`** as (complete file; keep the existing top doc comment about mirroring `knip --fix`, extended with one line noting the batch contract):

  ```ts
  import type {
    ExportSite,
    ParsedSource,
    SourceBatchResult,
    SourceEdit,
    SourceOp,
    TransformInput,
    TransformResult,
  } from './source.js';
  import type { BatchEdit, BatchOpResult } from './source.js';
  import {
    applySingleOp,
    findExportedFunctionSites,
    locateExport,
    pushEdit,
    removeListItems,
  } from './source.js';

  type SpecifierSite = Extract<ExportSite, { kind: 'specifier' }>;

  // [existing doc comment, verbatim, plus:]
  // Batch contract: one parse, all of the file's strip-export ops, edits
  // against ORIGINAL offsets. Ops covering several bindings of one export
  // list are coordinated here (subset -> generalized comma hygiene; ALL
  // bindings -> whole-statement removal, the same range the single-op path
  // uses for a sole specifier).
  export function stripExportBatch(
    parsed: ParsedSource,
    _content: string,
    ops: readonly SourceOp[],
  ): SourceBatchResult {
    const { program } = parsed;
    const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
    const edits: BatchEdit[] = [];
    // One export-list statement can absorb several ops; collect them per
    // statement (keyed by statementStart) and coordinate below.
    const listGroups = new Map<number, { site: SpecifierSite; opIndex: number }[]>();

    ops.forEach((op, opIndex) => {
      const located = locateExport(program, op.symbol, op.pos);
      if ('error' in located) {
        results[opIndex] = { ok: false, reason: located.error };
        return;
      }
      const site = located.site;
      if (site.kind === 'declaration') {
        const fnSites = findExportedFunctionSites(program, op.symbol);
        if (fnSites.length > 1) {
          for (const fn of fnSites) pushEdit(edits, { start: fn.exportStart, end: fn.declStart }, [opIndex]);
          return;
        }
        // Multi-declarator statements produce the same whole-statement
        // unexport for every declarator's op — pushEdit dedupes them.
        pushEdit(edits, { start: site.exportStart, end: site.declStart }, [opIndex]);
      } else if (site.kind === 'specifier') {
        const group = listGroups.get(site.statementStart) ?? [];
        group.push({ site, opIndex });
        listGroups.set(site.statementStart, group);
      } else if (site.isNamed) {
        pushEdit(edits, { start: site.statementStart, end: site.declStart }, [opIndex]);
      } else {
        pushEdit(edits, { start: site.statementStart, end: site.statementEnd }, [opIndex]);
      }
    });

    for (const group of listGroups.values()) {
      const site = group[0]!.site;
      const indexOwners = new Map<number, number[]>();
      for (const g of group) indexOwners.set(g.site.index, [...(indexOwners.get(g.site.index) ?? []), g.opIndex]);
      if (indexOwners.size === site.specifiers.length) {
        pushEdit(
          edits,
          { start: site.statementStart, end: site.statementEnd },
          group.map((g) => g.opIndex),
        );
        continue;
      }
      const indices = [...indexOwners.keys()].sort((a, b) => a - b);
      for (const removal of removeListItems(site.specifiers, indices)) {
        pushEdit(
          edits,
          { start: removal.start, end: removal.end } satisfies SourceEdit,
          removal.itemIndices.flatMap((i) => indexOwners.get(i)!),
        );
      }
    }

    return { results, edits };
  }

  export function stripExport(input: TransformInput): TransformResult {
    return applySingleOp(input.filePath, input.content, { symbol: input.symbol, pos: input.pos }, stripExportBatch);
  }
  ```

- [ ] Run `pnpm test tests/unit/batch-strip-export.test.ts` — expected: PASS.
- [ ] Run `pnpm test` — expected: entire suite green (`transform-exports.test.ts` now exercises the wrapper; zero test edits).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `feat: batch transform contract + stripExportBatch with single-op wrapper (#32)`

---

## Task 3: deleteDeclarationBatch + removeDuplicateBatch

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/delete-declaration.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/remove-duplicate.ts`
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/batch-delete-declaration.test.ts`
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/batch-remove-duplicate.test.ts`

**Interfaces**
- Consumes (from Task 2's source.ts): `SourceEdit`, `SourceOp`, `BatchEdit`, `BatchOpResult`, `SourceBatchResult`, `pushEdit`, `removeListItems`, `applySingleOp`, plus the pre-existing `locateExport`, `findExportedFunctionSites`, `findTopLevelDeclarationSpan`, `expandStartWithLeadingComments`, `expandEndWithTrailingNewline`, `ExportSite`, `ParsedSource`.
- Produces:

  ```ts
  export function deleteDeclarationBatch(parsed: ParsedSource, content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function deleteDeclaration(input: TransformInput): TransformResult   // wrapper
  export function removeDuplicateBatch(parsed: ParsedSource, content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function removeDuplicate(input: TransformInput): TransformResult     // wrapper
  ```

### Steps

- [ ] **Write the failing tests.** Create `tests/unit/batch-delete-declaration.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { deleteDeclarationBatch } from '../../src/fix/transforms/delete-declaration.js';
  import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

  function run(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = deleteDeclarationBatch(parsed, content, ops);
    return { results, out: applyEdits(content, edits) };
  }

  describe('deleteDeclarationBatch: adjacent declarators of one statement', () => {
    const content = 'export const a = 1, b = 2, c = 3;\n';

    it('removes the two leading declarators', () => {
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const c = 3;\n');
    });

    it('removes the two trailing declarators with one combined edit', () => {
      const { out } = run(content, [
        { symbol: 'b', pos: content.indexOf('b = 2') },
        { symbol: 'c', pos: content.indexOf('c = 3') },
      ]);
      expect(out).toBe('export const a = 1;\n');
    });

    it('removes a non-adjacent pair', () => {
      const { out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'c', pos: content.indexOf('c = 3') },
      ]);
      expect(out).toBe('export const b = 2;\n');
    });

    it('removing ALL declarators deletes the whole statement including attached comments', () => {
      const withDoc = '/**\n * Doc.\n */\nexport const a = 1, b = 2;\nexport const keep = 3;\n';
      const { results, out } = run(withDoc, [
        { symbol: 'a', pos: withDoc.indexOf('a = 1') },
        { symbol: 'b', pos: withDoc.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const keep = 3;\n');
    });
  });

  describe('deleteDeclarationBatch: emptying an export list', () => {
    it('removes both local declarations and the whole export statement', () => {
      const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a, b') },
        { symbol: 'b', pos: content.indexOf('b };') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('');
    });
  });

  describe('deleteDeclarationBatch: overload set + neighbor in one batch', () => {
    it('sweeps the whole overload set and deletes the neighbor declaration', () => {
      const content =
        'export function f(x: string): void;\n' +
        'export function f(x: number): void;\n' +
        'export function f(x: unknown): void {}\n' +
        'export const keep = 1;\n' +
        'export const gone = 2;\n';
      const { results, out } = run(content, [
        { symbol: 'f', pos: content.indexOf('f(') },
        { symbol: 'gone', pos: content.indexOf('gone') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const keep = 1;\n');
    });
  });

  describe('deleteDeclarationBatch: two list bindings sharing one local declaration', () => {
    it('dedupes the shared local-declaration edit instead of double-removing it', () => {
      const content = "function f() { return 1; }\nexport { f };\nexport { f as g };\n";
      const { results, out } = run(content, [
        { symbol: 'f', pos: content.indexOf('f };') },
        { symbol: 'g', pos: content.indexOf('f as g') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('');
    });
  });

  describe('deleteDeclarationBatch: adjacent whole statements with attached comments', () => {
    it('produces touching (non-overlapping) edits', () => {
      const content = '// a\nexport const a = 1;\n// b\nexport const b = 2;\nexport const keep = 3;\n';
      const { results, out } = run(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const keep = 3;\n');
    });
  });
  ```

  Create `tests/unit/batch-remove-duplicate.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { removeDuplicateBatch } from '../../src/fix/transforms/remove-duplicate.js';
  import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

  function run(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = removeDuplicateBatch(parsed, content, ops);
    return { results, out: applyEdits(content, edits) };
  }

  describe('removeDuplicateBatch: multi-alias groups', () => {
    it('removes two aliasing statements (one with an attached comment), keeping the canonical', () => {
      const content =
        'export const src = 1;\nexport const alias1 = src;\n// alias2 doc\nexport const alias2 = src;\n';
      const { results, out } = run(content, [
        { symbol: 'alias1', pos: content.indexOf('alias1') },
        { symbol: 'alias2', pos: content.indexOf('alias2 =') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const src = 1;\n');
    });

    it('removes every alias specifier of one list -> whole statement', () => {
      const content = 'export const original = 1;\nexport { original as a1, original as a2 };\n';
      const { results, out } = run(content, [
        { symbol: 'a1', pos: content.indexOf('original as a1') },
        { symbol: 'a2', pos: content.indexOf('original as a2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export const original = 1;\n');
    });

    it('removes a subset of alias specifiers with comma hygiene', () => {
      const content =
        'export const original = 1;\nexport { original as a1, original as a2, original as a3 };\n';
      const { out } = run(content, [
        { symbol: 'a1', pos: content.indexOf('original as a1') },
        { symbol: 'a3', pos: content.indexOf('original as a3') },
      ]);
      expect(out).toBe('export const original = 1;\nexport { original as a2 };\n');
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/batch-delete-declaration.test.ts tests/unit/batch-remove-duplicate.test.ts` — expected: FAIL (unresolved exports).

- [ ] **Rewrite `src/fix/transforms/delete-declaration.ts`.** Keep the existing module doc comment verbatim (it describes behavior that still holds), drop the `magic-string` import, and replace the body with (complete):

  ```ts
  import type {
    ExportSite,
    ParsedSource,
    SourceBatchResult,
    SourceEdit,
    SourceOp,
    TransformInput,
    TransformResult,
  } from './source.js';
  import type { BatchEdit, BatchOpResult } from './source.js';
  import {
    applySingleOp,
    expandEndWithTrailingNewline,
    expandStartWithLeadingComments,
    findExportedFunctionSites,
    findTopLevelDeclarationSpan,
    locateExport,
    pushEdit,
    removeListItems,
  } from './source.js';

  type SpecifierSite = Extract<ExportSite, { kind: 'specifier' }>;
  type DeclarationSite = Extract<ExportSite, { kind: 'declaration' }>;

  // [existing module doc comment verbatim]
  export function deleteDeclarationBatch(
    parsed: ParsedSource,
    content: string,
    ops: readonly SourceOp[],
  ): SourceBatchResult {
    const { program, comments } = parsed;
    const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
    const edits: BatchEdit[] = [];
    const sweep = (start: number, end: number): SourceEdit => ({
      start: expandStartWithLeadingComments(content, comments, start),
      end: expandEndWithTrailingNewline(content, end),
    });

    // declaration ops on one multi-declarator statement, keyed by exportStart
    const declaratorGroups = new Map<number, { site: DeclarationSite; declIndex: number; opIndex: number }[]>();
    // specifier ops per export-list statement, keyed by statementStart
    const listGroups = new Map<number, { site: SpecifierSite; opIndex: number }[]>();

    ops.forEach((op, opIndex) => {
      const located = locateExport(program, op.symbol, op.pos);
      if ('error' in located) {
        results[opIndex] = { ok: false, reason: located.error };
        return;
      }
      const site = located.site;
      if (site.kind === 'declaration') {
        const fnSites = findExportedFunctionSites(program, op.symbol);
        if (fnSites.length > 1) {
          for (const fn of fnSites) pushEdit(edits, sweep(fn.deleteStart, fn.statementEnd), [opIndex]);
          return;
        }
        if (site.declarators && site.declarators.length > 1 && site.declaratorIndex !== undefined) {
          const group = declaratorGroups.get(site.exportStart) ?? [];
          group.push({ site, declIndex: site.declaratorIndex, opIndex });
          declaratorGroups.set(site.exportStart, group);
          return;
        }
        pushEdit(edits, sweep(site.deleteStart, site.statementEnd), [opIndex]);
      } else if (site.kind === 'default') {
        pushEdit(edits, sweep(site.statementStart, site.statementEnd), [opIndex]);
      } else {
        if (!site.isReexport) {
          const localSpan = findTopLevelDeclarationSpan(program, site.localName);
          // Two list bindings can share one local declaration
          // (`export { f }; export { f as g };`) — pushEdit dedupes the sweep.
          if (localSpan) pushEdit(edits, sweep(localSpan.start, localSpan.end), [opIndex]);
        }
        const group = listGroups.get(site.statementStart) ?? [];
        group.push({ site, opIndex });
        listGroups.set(site.statementStart, group);
      }
    });

    for (const group of declaratorGroups.values()) {
      const site = group[0]!.site;
      const declarators = site.declarators!;
      const indexOwners = new Map<number, number[]>();
      for (const g of group) indexOwners.set(g.declIndex, [...(indexOwners.get(g.declIndex) ?? []), g.opIndex]);
      if (indexOwners.size === declarators.length) {
        // Every declarator of the statement is flagged -> the whole statement
        // goes (with attached comments), exactly like the sole-declarator path.
        pushEdit(edits, sweep(site.deleteStart, site.statementEnd), group.map((g) => g.opIndex));
        continue;
      }
      const indices = [...indexOwners.keys()].sort((a, b) => a - b);
      for (const removal of removeListItems(declarators, indices)) {
        pushEdit(
          edits,
          { start: removal.start, end: removal.end },
          removal.itemIndices.flatMap((i) => indexOwners.get(i)!),
        );
      }
    }

    for (const group of listGroups.values()) {
      const site = group[0]!.site;
      const indexOwners = new Map<number, number[]>();
      for (const g of group) indexOwners.set(g.site.index, [...(indexOwners.get(g.site.index) ?? []), g.opIndex]);
      if (indexOwners.size === site.specifiers.length) {
        pushEdit(edits, sweep(site.statementStart, site.statementEnd), group.map((g) => g.opIndex));
        continue;
      }
      const indices = [...indexOwners.keys()].sort((a, b) => a - b);
      for (const removal of removeListItems(site.specifiers, indices)) {
        pushEdit(
          edits,
          { start: removal.start, end: removal.end },
          removal.itemIndices.flatMap((i) => indexOwners.get(i)!),
        );
      }
    }

    return { results, edits };
  }

  export function deleteDeclaration(input: TransformInput): TransformResult {
    return applySingleOp(input.filePath, input.content, { symbol: input.symbol, pos: input.pos }, deleteDeclarationBatch);
  }
  ```

- [ ] **Rewrite `src/fix/transforms/remove-duplicate.ts`.** Keep the module doc comment verbatim; drop the `magic-string` import; replace the body with (complete):

  ```ts
  import type {
    ExportSite,
    ParsedSource,
    SourceBatchResult,
    SourceEdit,
    SourceOp,
    TransformInput,
    TransformResult,
  } from './source.js';
  import type { BatchEdit, BatchOpResult } from './source.js';
  import {
    applySingleOp,
    expandEndWithTrailingNewline,
    expandStartWithLeadingComments,
    locateExport,
    pushEdit,
    removeListItems,
  } from './source.js';

  type SpecifierSite = Extract<ExportSite, { kind: 'specifier' }>;

  // [existing module doc comment verbatim]
  export function removeDuplicateBatch(
    parsed: ParsedSource,
    content: string,
    ops: readonly SourceOp[],
  ): SourceBatchResult {
    const { program, comments } = parsed;
    const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
    const edits: BatchEdit[] = [];
    const sweep = (start: number, end: number): SourceEdit => ({
      start: expandStartWithLeadingComments(content, comments, start),
      end: expandEndWithTrailingNewline(content, end),
    });
    const listGroups = new Map<number, { site: SpecifierSite; opIndex: number }[]>();

    ops.forEach((op, opIndex) => {
      const located = locateExport(program, op.symbol, op.pos);
      if ('error' in located) {
        results[opIndex] = { ok: false, reason: located.error };
        return;
      }
      const site = located.site;
      if (site.kind === 'declaration') {
        pushEdit(edits, sweep(site.deleteStart, site.statementEnd), [opIndex]);
      } else if (site.kind === 'default') {
        pushEdit(edits, sweep(site.statementStart, site.statementEnd), [opIndex]);
      } else {
        const group = listGroups.get(site.statementStart) ?? [];
        group.push({ site, opIndex });
        listGroups.set(site.statementStart, group);
      }
    });

    for (const group of listGroups.values()) {
      const site = group[0]!.site;
      const indexOwners = new Map<number, number[]>();
      for (const g of group) indexOwners.set(g.site.index, [...(indexOwners.get(g.site.index) ?? []), g.opIndex]);
      if (indexOwners.size === site.specifiers.length) {
        pushEdit(edits, sweep(site.statementStart, site.statementEnd), group.map((g) => g.opIndex));
        continue;
      }
      const indices = [...indexOwners.keys()].sort((a, b) => a - b);
      for (const removal of removeListItems(site.specifiers, indices)) {
        pushEdit(
          edits,
          { start: removal.start, end: removal.end },
          removal.itemIndices.flatMap((i) => indexOwners.get(i)!),
        );
      }
    }

    return { results, edits };
  }

  export function removeDuplicate(input: TransformInput): TransformResult {
    return applySingleOp(input.filePath, input.content, { symbol: input.symbol, pos: input.pos }, removeDuplicateBatch);
  }
  ```

- [ ] Run `pnpm test tests/unit/batch-delete-declaration.test.ts tests/unit/batch-remove-duplicate.test.ts` — expected: PASS.
- [ ] Run `pnpm test` — expected: entire suite green (`transform-exports`, `transform-members`, `transform-comment-adjacency` now run through the wrappers).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `feat: deleteDeclarationBatch and removeDuplicateBatch (#32)`

---

## Task 4: removeMemberBatch — multi-member enum/namespace boundaries

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/remove-member.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/transforms/source.ts` (delete `removeListItem` — its last caller disappears here)
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/batch-remove-member.test.ts`

**Interfaces**
- Consumes: Task 2's `SourceOp`/`BatchEdit`/`BatchOpResult`/`SourceBatchResult`/`pushEdit`/`removeListItems`/`applySingleOp`, plus remove-member.ts's own private `findParent`, `findEnumMemberIndex`, `findNamespaceMember`, `lineTrailingEnd` and source.ts's `expandStartWithLeadingComments`, `expandEndWithTrailingNewline`, `Span`.
- Produces:

  ```ts
  export function removeMemberBatch(parsed: ParsedSource, content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult  // wrapper
  export function locateMemberAnchor(program: Program, parentSymbol: string, symbol: string, pos?: number): { anchor: number } | { error: string }  // unchanged
  ```

### Steps

- [ ] **Write the failing test.** Create `tests/unit/batch-remove-member.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { removeMemberBatch } from '../../src/fix/transforms/remove-member.js';
  import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

  function run(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = removeMemberBatch(parsed, content, ops);
    return { results, out: applyEdits(content, edits) };
  }

  describe('removeMemberBatch: enum members', () => {
    it('removes an adjacent middle run with one combined edit', () => {
      const content = 'export enum Foo {\n  A,\n  B,\n  C,\n  D,\n}\n';
      const { results, out } = run(content, [
        { symbol: 'B', parentSymbol: 'Foo' },
        { symbol: 'C', parentSymbol: 'Foo' },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export enum Foo {\n  A,\n  D,\n}\n');
    });

    it('removes a trailing run without eating the survivor same-line trailing comment', () => {
      const content = 'export enum Foo {\n  Red, // r\n  Blue, // b\n  Green, // g\n}\n';
      const { results, out } = run(content, [
        { symbol: 'Blue', parentSymbol: 'Foo' },
        { symbol: 'Green', parentSymbol: 'Foo' },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export enum Foo {\n  Red, // r\n}\n');
    });

    it('removes a non-adjacent pair including the last member', () => {
      const content = 'export enum Foo {\n  A,\n  B,\n  C,\n  D,\n}\n';
      const { out } = run(content, [
        { symbol: 'B', parentSymbol: 'Foo' },
        { symbol: 'D', parentSymbol: 'Foo' },
      ]);
      expect(out).toBe('export enum Foo {\n  A,\n  C,\n}\n');
    });

    it('removing ALL members leaves the empty enum shell (as op-by-op removal did)', () => {
      const content = 'export enum Foo {\n  A,\n  B,\n}\n';
      const { out } = run(content, [
        { symbol: 'A', parentSymbol: 'Foo' },
        { symbol: 'B', parentSymbol: 'Foo' },
      ]);
      expect(out).toBe('export enum Foo {\n  \n}\n');
    });

    it('an all-members run sweeps a leading JSDoc on the first member', () => {
      const content = 'enum E {\n  /** doc for A */\n  A = 1,\n  B = 2,\n}\n';
      const { out } = run(content, [
        { symbol: 'A', parentSymbol: 'E' },
        { symbol: 'B', parentSymbol: 'E' },
      ]);
      expect(out).toBe('enum E {\n  \n}\n');
    });
  });

  describe('removeMemberBatch: namespace members', () => {
    it('removes a non-last and the last member in one batch', () => {
      const content =
        'export namespace NS {\n  export const first = 1;\n  export const second = 2;\n  export const third = 3;\n}\n';
      const { results, out } = run(content, [
        { symbol: 'first', parentSymbol: 'NS' },
        { symbol: 'third', parentSymbol: 'NS' },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('export namespace NS {\n  export const second = 2;\n  }\n');
    });

    it('removes an adjacent run covering the whole body', () => {
      const content = 'export namespace NS {\n  export const a = 1;\n  export const b = 2;\n}\n';
      const { out } = run(content, [
        { symbol: 'a', parentSymbol: 'NS' },
        { symbol: 'b', parentSymbol: 'NS' },
      ]);
      expect(out).toBe('export namespace NS {\n  }\n');
    });

    it('removes a subset of declarators of one member statement', () => {
      const content = 'export namespace NS {\n  export const a = 1, b = 2, c = 3;\n}\n';
      const { out } = run(content, [
        { symbol: 'a', parentSymbol: 'NS' },
        { symbol: 'c', parentSymbol: 'NS' },
      ]);
      expect(out).toBe('export namespace NS {\n  export const b = 2;\n}\n');
    });

    it('removing every declarator of a member statement removes the whole statement', () => {
      const content = 'export namespace NS {\n  export const a = 1, b = 2;\n}\n';
      const { out } = run(content, [
        { symbol: 'a', parentSymbol: 'NS' },
        { symbol: 'b', parentSymbol: 'NS' },
      ]);
      expect(out).toBe('export namespace NS {\n  }\n');
    });

    it('an op without parentSymbol fails without disturbing the batch', () => {
      const content = 'export enum Foo {\n  A,\n  B,\n}\n';
      const { results, out } = run(content, [
        { symbol: 'A' },
        { symbol: 'B', parentSymbol: 'Foo' },
      ]);
      expect(results[0]).toEqual({ ok: false, reason: 'remove-member requires a parentSymbol' });
      expect(results[1]).toEqual({ ok: true });
      expect(out).toBe('export enum Foo {\n  A,\n}\n');
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/batch-remove-member.test.ts` — expected: FAIL (unresolved export `removeMemberBatch`).

- [ ] **Modify `NamespaceMemberMatch` and `findNamespaceMember`** in `src/fix/transforms/remove-member.ts`:
  - In the `NamespaceMemberMatch` interface: DELETE the `next: Span | null` field (and its comment); ADD `bodyIndex: number;` with comment `// Index of the member statement in its namespace body — run/boundary math.`
  - In `findNamespaceMember`, replace the match construction

    ```ts
    const nextStmt = body[i + 1];
    const match: NamespaceMemberMatch = {
      stmt: { start: stmt.start, end: stmt.end },
      next: nextStmt ? { start: nextStmt.start, end: nextStmt.end } : null,
    };
    ```

    with

    ```ts
    const match: NamespaceMemberMatch = {
      stmt: { start: stmt.start, end: stmt.end },
      bodyIndex: i,
    };
    ```

- [ ] **Replace `removeMember` and delete `removeEnumMember`.** Delete the `removeEnumMember` function and the `import MagicString from 'magic-string';` line. Keep `lineTrailingEnd`, `findEnumMemberIndex`, `enumMemberName`, `findParent`, `findNamespaceMember`, `locateMemberAnchor` (all otherwise unchanged). Keep the module doc comment; append to it: `// Multi-op boundaries: consecutive removed members/statements collapse into RUN edits so ranges never overlap; a trailing enum run is bounded by lineTrailingEnd on both sides (comment-aware).` Replace the `removeMember` implementation with (complete):

  ```ts
  export function removeMemberBatch(
    parsed: ParsedSource,
    content: string,
    ops: readonly SourceOp[],
  ): SourceBatchResult {
    const { program, comments } = parsed;
    const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
    const edits: BatchEdit[] = [];

    interface EnumGroup {
      decl: TSEnumDeclaration;
      indexOwners: Map<number, number[]>; // member index -> op indexes
    }
    interface NsEntry {
      match: NamespaceMemberMatch;
      owners: number[];
      declaratorOwners: Map<number, number[]>; // declarator index -> op indexes
    }
    interface NsGroup {
      body: (Directive | Statement)[];
      entries: Map<number, NsEntry>; // keyed by bodyIndex
    }
    const enumGroups = new Map<number, EnumGroup>(); // keyed by enum decl start
    const nsGroups = new Map<number, NsGroup>(); // keyed by namespace decl start

    ops.forEach((op, opIndex) => {
      if (op.parentSymbol === undefined) {
        results[opIndex] = { ok: false, reason: 'remove-member requires a parentSymbol' };
        return;
      }
      const parent = findParent(program.body, op.parentSymbol);
      if (!parent) {
        results[opIndex] = { ok: false, reason: `parent '${op.parentSymbol}' not found` };
        return;
      }
      if (parent.kind === 'enum') {
        const index = findEnumMemberIndex(parent.decl.body.members, op.symbol, op.pos);
        if (index === -1) {
          results[opIndex] = { ok: false, reason: `member '${op.symbol}' not found in enum '${op.parentSymbol}'` };
          return;
        }
        const group = enumGroups.get(parent.decl.start) ?? { decl: parent.decl, indexOwners: new Map() };
        group.indexOwners.set(index, [...(group.indexOwners.get(index) ?? []), opIndex]);
        enumGroups.set(parent.decl.start, group);
        return;
      }
      const match = findNamespaceMember(parent.decl.body.body, op.symbol, op.pos);
      if (!match) {
        results[opIndex] = {
          ok: false,
          reason: `member '${op.symbol}' not found in namespace '${op.parentSymbol}'`,
        };
        return;
      }
      const group = nsGroups.get(parent.decl.start) ?? { body: parent.decl.body.body, entries: new Map() };
      const entry = group.entries.get(match.bodyIndex) ?? { match, owners: [], declaratorOwners: new Map() };
      entry.owners.push(opIndex);
      if (match.declarators && match.declarators.length > 1 && match.declaratorIndex !== undefined) {
        entry.declaratorOwners.set(match.declaratorIndex, [
          ...(entry.declaratorOwners.get(match.declaratorIndex) ?? []),
          opIndex,
        ]);
      }
      group.entries.set(match.bodyIndex, entry);
      nsGroups.set(parent.decl.start, group);
    });

    // --- enum edits: runs of consecutive removed members ---
    for (const group of enumGroups.values()) {
      const members = group.decl.body.members;
      const sorted = [...group.indexOwners.keys()].sort((a, b) => a - b);
      const runs: number[][] = [];
      for (const index of sorted) {
        const run = runs[runs.length - 1];
        if (run && run[run.length - 1] === index - 1) run.push(index);
        else runs.push([index]);
      }
      for (const run of runs) {
        const first = members[run[0]!]!;
        const last = members[run[run.length - 1]!]!;
        const owners = run.flatMap((index) => group.indexOwners.get(index)!);
        if (run[run.length - 1]! < members.length - 1) {
          // A member survives after the run: the single-op non-last rule,
          // applied to the whole run (own-line leading comments swept in,
          // bounded at the survivor's start so it keeps its indentation).
          pushEdit(
            edits,
            {
              start: expandStartWithLeadingComments(content, comments, first.start),
              end: members[run[run.length - 1]! + 1]!.start,
            },
            owners,
          );
        } else {
          // Trailing run: comment-aware on both sides. The previous survivor's
          // same-line trailing comment stays; the removed members' commas and
          // trailing comments go. No previous survivor (whole list removed):
          // a single sole member keeps the old single-op range byte-for-byte;
          // a longer run sweeps the first member's leading comments too.
          const prev = members[run[0]! - 1];
          const start = prev
            ? lineTrailingEnd(content, comments, prev.end)
            : run.length === 1
              ? first.start
              : expandStartWithLeadingComments(content, comments, first.start);
          pushEdit(edits, { start, end: lineTrailingEnd(content, comments, last.end) }, owners);
        }
      }
    }

    // --- namespace edits ---
    for (const group of nsGroups.values()) {
      const fullRemovals: { bodyIndex: number; match: NamespaceMemberMatch; owners: number[] }[] = [];
      for (const [bodyIndex, entry] of group.entries) {
        const declarators = entry.match.declarators;
        const isPartial =
          declarators !== undefined &&
          declarators.length > 1 &&
          entry.declaratorOwners.size > 0 &&
          entry.declaratorOwners.size < declarators.length;
        if (isPartial) {
          // A strict subset of one statement's declarators: comma hygiene,
          // never touching live siblings — same rule as top level.
          const indices = [...entry.declaratorOwners.keys()].sort((a, b) => a - b);
          for (const removal of removeListItems(declarators, indices)) {
            pushEdit(
              edits,
              { start: removal.start, end: removal.end },
              removal.itemIndices.flatMap((i) => entry.declaratorOwners.get(i)!),
            );
          }
        } else {
          fullRemovals.push({ bodyIndex, match: entry.match, owners: entry.owners });
        }
      }
      fullRemovals.sort((a, b) => a.bodyIndex - b.bodyIndex);
      let run: typeof fullRemovals = [];
      const flush = (): void => {
        if (run.length === 0) return;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const owners = run.flatMap((r) => r.owners);
        const from = expandStartWithLeadingComments(content, comments, first.match.stmt.start);
        const nextStmt = group.body[last.bodyIndex + 1];
        if (nextStmt) {
          // Bound at the next (surviving) statement's start so the survivor
          // keeps exactly one indentation — same rule as the single-op path.
          pushEdit(edits, { start: from, end: nextStmt.start }, owners);
        } else {
          pushEdit(
            edits,
            { start: from, end: expandEndWithTrailingNewline(content, last.match.stmt.end) },
            owners,
          );
        }
        run = [];
      };
      for (const removal of fullRemovals) {
        if (run.length > 0 && run[run.length - 1]!.bodyIndex !== removal.bodyIndex - 1) flush();
        run.push(removal);
      }
      flush();
    }

    return { results, edits };
  }

  export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult {
    return applySingleOp(
      input.filePath,
      input.content,
      { symbol: input.symbol, pos: input.pos, parentSymbol: input.parentSymbol },
      removeMemberBatch,
    );
  }
  ```

  Import block for remove-member.ts becomes:

  ```ts
  import type {
    Comment,
    Declaration,
    Directive,
    Program,
    Statement,
    TSEnumDeclaration,
    TSEnumMember,
    TSModuleBlock,
    TSModuleDeclaration,
  } from 'oxc-parser';
  import type {
    ParsedSource,
    SourceBatchResult,
    SourceOp,
    Span,
    TransformInput,
    TransformResult,
  } from './source.js';
  import type { BatchEdit, BatchOpResult } from './source.js';
  import {
    applySingleOp,
    expandEndWithTrailingNewline,
    expandStartWithLeadingComments,
    pushEdit,
    removeListItems,
  } from './source.js';
  ```

- [ ] **Delete `removeListItem` (singular) from `src/fix/transforms/source.ts`** — its last importer is gone (verify with `grep -rn "removeListItem\b" src tests` → only `removeListItems` remains). Its comma-hygiene doc comment is already carried by `removeListItems`.
- [ ] Run `pnpm test tests/unit/batch-remove-member.test.ts` — expected: PASS.
- [ ] Run `pnpm test` — expected: entire suite green (all enum/namespace single-op tests, including the comment-adjacency suite and the real-fixture pos tests, pass through the wrapper).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `feat: removeMemberBatch with multi-member enum/namespace boundaries (#32)`

---

## Task 5: public-tag batches (insertions, parse-once)

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/ignore/public-tag.ts`
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/batch-public-tag.test.ts`

**Interfaces**
- Consumes: Task 2's batch contract from `../fix/transforms/source.js`; `locateMemberAnchor` from `../fix/transforms/remove-member.js` (unchanged).
- Produces:

  ```ts
  export function insertPublicTagBatch(parsed: ParsedSource, content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function insertMemberPublicTagBatch(parsed: ParsedSource, content: string, ops: readonly SourceOp[]): SourceBatchResult
  export function insertPublicTag(input: TransformInput): TransformResult                                  // wrapper
  export function insertMemberPublicTag(input: TransformInput & { parentSymbol: string }): TransformResult  // wrapper
  ```

### Steps

- [ ] **Write the failing test.** Create `tests/unit/batch-public-tag.test.ts` with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { insertMemberPublicTagBatch, insertPublicTagBatch } from '../../src/ignore/public-tag.js';
  import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

  function runTop(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = insertPublicTagBatch(parsed, content, ops);
    return { results, edits, out: applyEdits(content, edits) };
  }

  function runMember(content: string, ops: SourceOp[]) {
    const parsed = parseSource('a.ts', content);
    const { results, edits } = insertMemberPublicTagBatch(parsed, content, ops);
    return { results, edits, out: applyEdits(content, edits) };
  }

  describe('insertPublicTagBatch', () => {
    it('tags two declarations from one parse', () => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      const { results, out } = runTop(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe('/** @public */\nexport const a = 1;\n/** @public */\nexport const b = 2;\n');
    });

    it('mixes a multi-line JSDoc merge with a fresh insertion', () => {
      const content = '/**\n * Doc.\n */\nexport function foo() {\n  return 1;\n}\nexport const bar = 2;\n';
      const { out } = runTop(content, [
        { symbol: 'foo', pos: content.indexOf('foo') },
        { symbol: 'bar', pos: content.indexOf('bar') },
      ]);
      expect(out).toBe(
        '/**\n * Doc.\n * @public\n */\nexport function foo() {\n  return 1;\n}\n/** @public */\nexport const bar = 2;\n',
      );
    });

    it('mixes a single-line JSDoc expansion (replacement edit) with a fresh insertion', () => {
      const content = '/** Doc. */\nexport const foo = 1;\nexport const bar = 2;\n';
      const { out } = runTop(content, [
        { symbol: 'foo', pos: content.indexOf('foo') },
        { symbol: 'bar', pos: content.indexOf('bar') },
      ]);
      expect(out).toBe(
        '/**\n * Doc.\n * @public\n */\nexport const foo = 1;\n/** @public */\nexport const bar = 2;\n',
      );
    });

    it('an already-tagged op is ok with no edit; the other op still lands', () => {
      const content = '/** @public */\nexport const a = 1;\nexport const b = 2;\n';
      const { results, edits, out } = runTop(content, [
        { symbol: 'a', pos: content.indexOf('a = 1') },
        { symbol: 'b', pos: content.indexOf('b = 2') },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(edits).toHaveLength(1);
      expect(out).toBe('/** @public */\nexport const a = 1;\n/** @public */\nexport const b = 2;\n');
    });
  });

  describe('insertMemberPublicTagBatch', () => {
    it('tags two enum members from one parse', () => {
      const content = 'export enum Color {\n  Red,\n  Blue,\n  Green,\n}\n';
      const { results, out } = runMember(content, [
        { symbol: 'Red', parentSymbol: 'Color' },
        { symbol: 'Green', parentSymbol: 'Color' },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(out).toBe(
        'export enum Color {\n  /** @public */\n  Red,\n  Blue,\n  /** @public */\n  Green,\n}\n',
      );
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/batch-public-tag.test.ts` — expected: FAIL (unresolved exports).

- [ ] **Rework `src/ignore/public-tag.ts`.** `findAdjacentJSDoc` and `lastLineStart` stay verbatim. Mechanical recipe:
  1. Replace the import block with:

     ```ts
     import type { Comment } from 'oxc-parser';
     import { locateMemberAnchor } from '../fix/transforms/remove-member.js';
     import type {
       ParsedSource,
       SourceBatchResult,
       SourceEdit,
       SourceOp,
       TransformInput,
       TransformResult,
     } from '../fix/transforms/source.js';
     import type { BatchEdit, BatchOpResult } from '../fix/transforms/source.js';
     import {
       applySingleOp,
       findTopLevelDeclarationSpan,
       locateExport,
       pushEdit,
       startsOwnLine,
     } from '../fix/transforms/source.js';
     ```

     (drop `magic-string` — no MagicString is built here anymore).
  2. Rework `applyPublicTagAtAnchor` into `publicTagEditAtAnchor` — identical decision tree, but each branch RETURNS the edit instead of applying it (keep every existing branch comment verbatim):

     ```ts
     // Computes the SourceEdit that inserts `@public` into the JSDoc attached
     // directly above `anchor` (creating a fresh `/** @public */` line when
     // none exists), or null when the JSDoc already documents @public
     // (idempotent no-op). [keep the rest of the original doc comment]
     function publicTagEditAtAnchor(content: string, comments: Comment[], anchor: number): SourceEdit | null {
       const nl = content.includes('\r\n') ? '\r\n' : '\n';
       const existing = findAdjacentJSDoc(content, comments, anchor);
       if (existing) {
         if (/@public\b/.test(existing.value)) return null;
         const closingStart = existing.end - 2;
         const isSingleLine = !content.slice(existing.start, existing.end).includes('\n');
         const commentLineStart = lastLineStart(content, existing.start);
         const commentIndent = content.slice(commentLineStart, existing.start);
         if (isSingleLine && /^[ \t]*$/.test(commentIndent)) {
           const inner = existing.value.replace(/^\*/, '').trim();
           const innerLine = inner === '' ? '' : `${commentIndent} * ${inner}${nl}`;
           return {
             start: existing.start,
             end: existing.end,
             text: `/**${nl}${innerLine}${commentIndent} * @public${nl}${commentIndent} */`,
           };
         }
         const closingLineStart = lastLineStart(content, closingStart);
         const closingPrefix = content.slice(closingLineStart, closingStart);
         if (/^[ \t]*$/.test(closingPrefix)) {
           return { start: closingLineStart, end: closingLineStart, text: `${closingPrefix}* @public${nl}` };
         }
         const before = content[closingStart - 1] ?? '';
         const pad = before === ' ' || before === '\t' ? '' : ' ';
         return { start: closingStart, end: closingStart, text: `${pad}@public ` };
       }
       const lineStart = lastLineStart(content, anchor);
       const indent = content.slice(lineStart, anchor);
       return { start: lineStart, end: lineStart, text: `${indent}/** @public */${nl}` };
     }
     ```

  3. Replace `insertPublicTag`/`insertMemberPublicTag` with batch + wrapper (keep their module doc comments on the batch functions):

     ```ts
     export function insertPublicTagBatch(
       parsed: ParsedSource,
       content: string,
       ops: readonly SourceOp[],
     ): SourceBatchResult {
       const { program, comments } = parsed;
       const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
       const edits: BatchEdit[] = [];
       ops.forEach((op, opIndex) => {
         const located = locateExport(program, op.symbol, op.pos);
         if ('error' in located) {
           results[opIndex] = { ok: false, reason: located.error };
           return;
         }
         const site = located.site;
         let anchor: number;
         if (site.kind === 'declaration') {
           anchor = site.deleteStart;
         } else if (site.kind === 'default') {
           anchor = site.statementStart;
         } else {
           if (site.isReexport) {
             results[opIndex] = {
               ok: false,
               reason: `symbol '${op.symbol}' is a re-export with no local declaration to tag`,
             };
             return;
           }
           const localSpan = findTopLevelDeclarationSpan(program, site.localName);
           if (!localSpan) {
             results[opIndex] = { ok: false, reason: `no local declaration found for '${site.localName}'` };
             return;
           }
           anchor = localSpan.start;
         }
         const edit = publicTagEditAtAnchor(content, comments, anchor);
         // Two ops resolving to one anchor produce one identical insertion —
         // pushEdit dedupes it (batch-internal idempotency).
         if (edit) pushEdit(edits, edit, [opIndex]);
       });
       return { results, edits };
     }

     export function insertPublicTag(input: TransformInput): TransformResult {
       return applySingleOp(input.filePath, input.content, { symbol: input.symbol, pos: input.pos }, insertPublicTagBatch);
     }

     export function insertMemberPublicTagBatch(
       parsed: ParsedSource,
       content: string,
       ops: readonly SourceOp[],
     ): SourceBatchResult {
       const { program, comments } = parsed;
       const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
       const edits: BatchEdit[] = [];
       ops.forEach((op, opIndex) => {
         if (op.parentSymbol === undefined) {
           results[opIndex] = { ok: false, reason: 'member public tag requires a parentSymbol' };
           return;
         }
         const located = locateMemberAnchor(program, op.parentSymbol, op.symbol, op.pos);
         if ('error' in located) {
           results[opIndex] = { ok: false, reason: located.error };
           return;
         }
         const edit = publicTagEditAtAnchor(content, comments, located.anchor);
         if (edit) pushEdit(edits, edit, [opIndex]);
       });
       return { results, edits };
     }

     export function insertMemberPublicTag(input: TransformInput & { parentSymbol: string }): TransformResult {
       return applySingleOp(
         input.filePath,
         input.content,
         { symbol: input.symbol, pos: input.pos, parentSymbol: input.parentSymbol },
         insertMemberPublicTagBatch,
       );
     }
     ```

- [ ] Run `pnpm test tests/unit/batch-public-tag.test.ts` — expected: PASS.
- [ ] Run `pnpm test` — expected: entire suite green (all `insertPublicTag`/`insertMemberPublicTag` tests, incl. CRLF and idempotency, pass through the wrappers).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `feat: public-tag batch inserts, parse-once (#32)`

---

## Task 6: Compiler integration — one parse + one MagicString per file, conflict rule, chainTextEdits

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/compiler.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/plan.ts` (add `chainTextEdits`)
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/ignore/compile.ts`
- Test (create): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/compiler-batch.test.ts`

**Interfaces**
- Consumes: `stripExportBatch`, `deleteDeclarationBatch`, `removeDuplicateBatch`, `removeMemberBatch`, `insertPublicTagBatch`, `insertMemberPublicTagBatch`, and from source.ts `parseSource`, `applyEdits`, `SourceEdit`, `SourceOp`, `BatchOpResult`, `SourceBatchResult`, `ParsedSource` (all exactly as produced by Tasks 2–5).
- Produces:

  ```ts
  // src/fix/plan.ts
  export function chainTextEdits<T>(
    contentBefore: string,
    ops: readonly T[],
    step: (current: string, op: T) => TransformResult,
  ): { content: string; changed: boolean; results: TransformResult[] }
  ```

  Public signatures of `compileFixPlan`, `compileIgnorePlan`, `compileRemoveIgnoresPlan`, `FixSelection` are unchanged.

### Steps

- [ ] **Write the failing tests.** Create `tests/unit/compiler-batch.test.ts` with exactly:

  ```ts
  import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { dirname, join } from 'node:path';
  import { describe, expect, it } from 'vitest';
  import { compileFixPlan, type FixSelection } from '../../src/fix/compiler.js';
  import { compileIgnorePlan } from '../../src/ignore/compile.js';
  import { FIX_MODES_BY_TYPE, type Issue, type IssueType } from '../../src/core/types.js';

  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'knip-gui-compiler-batch-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function seedFile(root: string, relPath: string, content: string): Promise<void> {
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  function makeIssue(id: string, type: IssueType, filePath: string, overrides: Partial<Issue> = {}): Issue {
    const fixModes = overrides.fixModes ?? FIX_MODES_BY_TYPE[type];
    return { id, type, workspace: '.', filePath, fixable: fixModes.length > 0, fixModes, ...overrides };
  }

  function itemFor(items: { issueId: string; ok: boolean; reason?: string }[], issueId: string) {
    const item = items.find((i) => i.issueId === issueId);
    if (!item) throw new Error(`no plan item for issueId '${issueId}'`);
    return item;
  }

  describe('compileFixPlan: batch compilation per file', () => {
    it('cross-mode overlap fails the later mode op with the conflict reason', async () => {
      await withTmpDir(async (dir) => {
        const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
        await seedFile(dir, 'src/x.ts', content);
        const issues: Issue[] = [
          makeIssue('i1', 'exports', 'src/x.ts', {
            symbol: 'a',
            pos: content.indexOf('a, b'),
            fixModes: ['strip-export', 'delete-declaration'],
          }),
          makeIssue('i2', 'exports', 'src/x.ts', {
            symbol: 'b',
            pos: content.indexOf('b };'),
            fixModes: ['strip-export', 'delete-declaration'],
          }),
        ];
        const selection: FixSelection = { issueIds: ['i1', 'i2'], modeOverrides: { i2: 'delete-declaration' } };
        const plan = await compileFixPlan(dir, issues, selection);

        expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/x.ts' });
        expect(itemFor(plan.items, 'i2')).toEqual({
          issueId: 'i2',
          ok: false,
          reason: 'conflicts with another selected fix in the same statement',
          filePath: 'src/x.ts',
        });
        // The conflicting op's OTHER edit (deleting `function b`) is dropped too.
        expect(plan.patches).toHaveLength(1);
        expect(plan.patches[0]!.contentAfter).toBe(
          'function a() { return 1; }\nfunction b() { return 2; }\nexport { b };\n',
        );
      });
    });

    it('emptying an export list removes the whole statement', async () => {
      await withTmpDir(async (dir) => {
        const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
        await seedFile(dir, 'src/x.ts', content);
        const issues: Issue[] = [
          makeIssue('i1', 'exports', 'src/x.ts', { symbol: 'a', pos: content.indexOf('a, b') }),
          makeIssue('i2', 'exports', 'src/x.ts', { symbol: 'b', pos: content.indexOf('b };') }),
        ];
        const plan = await compileFixPlan(dir, issues, { issueIds: ['i1', 'i2'] });

        expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/x.ts' });
        expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/x.ts' });
        expect(plan.patches[0]!.contentAfter).toBe(
          'function a() { return 1; }\nfunction b() { return 2; }\n\n',
        );
      });
    });

    it('removes multiple members of one enum in one patch', async () => {
      await withTmpDir(async (dir) => {
        const content = 'export enum Color {\n  Red,\n  Blue,\n  Green,\n}\n';
        await seedFile(dir, 'src/enum.ts', content);
        const issues: Issue[] = [
          makeIssue('i1', 'enumMembers', 'src/enum.ts', {
            symbol: 'Blue',
            parentSymbol: 'Color',
            pos: content.indexOf('Blue'),
          }),
          makeIssue('i2', 'enumMembers', 'src/enum.ts', {
            symbol: 'Green',
            parentSymbol: 'Color',
            pos: content.indexOf('Green'),
          }),
        ];
        const plan = await compileFixPlan(dir, issues, { issueIds: ['i1', 'i2'] });

        expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/enum.ts' });
        expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/enum.ts' });
        expect(plan.patches[0]!.contentAfter).toBe('export enum Color {\n  Red,\n}\n');
      });
    });

    it('a duplicates issue with two aliases compiles to one ok item and one patch', async () => {
      await withTmpDir(async (dir) => {
        const content = 'export const src = 1;\nexport const alias1 = src;\nexport const alias2 = src;\n';
        await seedFile(dir, 'src/dup.ts', content);
        const issues: Issue[] = [
          makeIssue('i1', 'duplicates', 'src/dup.ts', {
            symbol: 'src, alias1, alias2',
            duplicateMembers: [
              { symbol: 'src', pos: content.indexOf('src = 1') },
              { symbol: 'alias1', pos: content.indexOf('alias1') },
              { symbol: 'alias2', pos: content.indexOf('alias2') },
            ],
          }),
        ];
        const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

        expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/dup.ts' });
        expect(plan.patches[0]!.contentAfter).toBe('export const src = 1;\n');
      });
    });

    it('mixed modes on one file cooperate when they do not overlap', async () => {
      await withTmpDir(async (dir) => {
        const content = 'export const a = 1;\nexport const b = 2;\n';
        await seedFile(dir, 'src/mix.ts', content);
        const issues: Issue[] = [
          makeIssue('i1', 'exports', 'src/mix.ts', {
            symbol: 'a',
            pos: content.indexOf('a = 1'),
            fixModes: ['strip-export', 'delete-declaration'],
          }),
          makeIssue('i2', 'exports', 'src/mix.ts', {
            symbol: 'b',
            pos: content.indexOf('b = 2'),
            fixModes: ['strip-export', 'delete-declaration'],
          }),
        ];
        const plan = await compileFixPlan(dir, issues, {
          issueIds: ['i1', 'i2'],
          modeOverrides: { i2: 'delete-declaration' },
        });

        expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/mix.ts' });
        expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/mix.ts' });
        expect(plan.patches).toHaveLength(1);
        expect(plan.patches[0]!.contentAfter).toBe('const a = 1;\n');
      });
    });
  });

  describe('compileIgnorePlan: batch tag insertion per file', () => {
    it('tags a member and a top-level export in one file with one patch (one parse)', async () => {
      await withTmpDir(async (dir) => {
        const content = 'export enum Color {\n  Red,\n  Blue,\n}\nexport const flag = 1;\n';
        await seedFile(dir, 'src/tags.ts', content);
        const issues: Issue[] = [
          makeIssue('m', 'enumMembers', 'src/tags.ts', {
            symbol: 'Blue',
            parentSymbol: 'Color',
            pos: content.indexOf('Blue'),
          }),
          makeIssue('t', 'exports', 'src/tags.ts', { symbol: 'flag', pos: content.indexOf('flag') }),
        ];
        const plan = await compileIgnorePlan(dir, issues, ['m', 't']);

        expect(itemFor(plan.items, 'm')).toEqual({ issueId: 'm', ok: true, filePath: 'src/tags.ts' });
        expect(itemFor(plan.items, 't')).toEqual({ issueId: 't', ok: true, filePath: 'src/tags.ts' });
        expect(plan.patches).toHaveLength(1);
        expect(plan.patches[0]!.contentAfter).toBe(
          'export enum Color {\n  Red,\n  /** @public */\n  Blue,\n}\n/** @public */\nexport const flag = 1;\n',
        );
      });
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/compiler-batch.test.ts` — expected: FAIL. Precisely: the conflict test fails (old chain compiles both ops without a conflict, producing different content), and others may pass or fail — the conflict test is the definitive red.

- [ ] **Add `chainTextEdits` to `src/fix/plan.ts`** (append; add `import type { TransformResult } from './transforms/source.js';` to the imports):

  ```ts
  // Chains genuinely-sequential text edits over tiny JSON documents
  // (package.json dependency removals, knip-config ignore edits), where each
  // step re-parses the current text — that per-step re-parse is fine for
  // documents this small (batching THOSE parses is #36). NOT for oxc source
  // transforms: those go through the per-mode batch functions, which see one
  // parse and original offsets.
  export function chainTextEdits<T>(
    contentBefore: string,
    ops: readonly T[],
    step: (current: string, op: T) => TransformResult,
  ): { content: string; changed: boolean; results: TransformResult[] } {
    let current = contentBefore;
    let changed = false;
    const results: TransformResult[] = [];
    for (const op of ops) {
      const result = step(current, op);
      if (result.ok) {
        if (result.newContent !== current) changed = true;
        current = result.newContent;
      }
      results.push(result);
    }
    return { content: current, changed, results };
  }
  ```

- [ ] **Rewrite the fix-plan half of `src/fix/compiler.ts`.**
  1. Replace the import block with:

     ```ts
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
     ```

  2. DELETE `runSourceTransform` (lines 75–93) and `runSourceChain` (lines 95–143) plus the local `interface SourceOp` (lines 67–73). Replace them with:

     ```ts
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
     ```

  3. In `compileFixPlan`'s gather loop, change `const sourceOpsByFile = new Map<string, SourceOp[]>();` to `new Map<string, CompilerSourceOp[]>()`, and the two op-push sites to cast the mode: the duplicates branch pushes `{ issueId, mode: mode as SourceMode, symbol: m.symbol, pos: m.pos }` and the final branch pushes `{ issueId, mode: mode as SourceMode, symbol: issue.symbol!, pos: issue.pos, parentSymbol: issue.parentSymbol }`. (The cast is sound: `delete-file` and `remove-dependency` are diverted above; the remaining `FixMode`s are exactly `SOURCE_MODE_ORDER`.)
  4. Replace the `for (const [filePath, ops] of sourceOpsByFile)` loop (lines 241–259) with parallel reads + per-file batch compile + event-loop yield:

     ```ts
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
     ```

  5. Replace the dep-loop body (lines 269–280, the `let current ... for (const op of ops)` block) with:

     ```ts
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
     ```

     (the trailing `if (changed) { ... }` patch block stays as-is).

- [ ] **Rewrite the two loops in `src/ignore/compile.ts`.**
  1. Update imports: drop `insertMemberPublicTag, insertPublicTag` and `TransformInput`; add:

     ```ts
     import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
     import { chainTextEdits, newPlanId, readFileOrNull, type FixPlan, type PlanItem } from '../fix/plan.js';
     import { applyEdits, parseSource, type BatchOpResult } from '../fix/transforms/source.js';
     import { insertMemberPublicTagBatch, insertPublicTagBatch } from './public-tag.js';
     ```

  2. Replace the config-edit loop body (the `let current ... for (const { issueId, edit } of configEdits)` block inside `compileIgnorePlan`) with — keeping the existing "Applied one edit at a time" comment:

     ```ts
     const { content: current, changed, results } = chainTextEdits(contentBefore, configEdits, (text, { edit }) =>
       addIgnores(text, configKind, [edit]),
     );
     configEdits.forEach(({ issueId }, i) => {
       const result = results[i]!;
       items.push(
         result.ok
           ? { issueId, ok: true, filePath: relPath }
           : { issueId, ok: false, reason: result.reason, filePath: relPath },
       );
     });
     ```

  3. Replace the whole `for (const [filePath, ops] of tagOpsByFile)` loop with parse-once batch application (insertions never conflict, so no conflict merge here):

     ```ts
     const tagEntries = [...tagOpsByFile];
     const tagContents = await Promise.all(
       tagEntries.map(([filePath]) => readFileOrNull(resolve(projectDir, filePath))),
     );
     for (let fileIndex = 0; fileIndex < tagEntries.length; fileIndex++) {
       const [filePath, ops] = tagEntries[fileIndex]!;
       const contentBefore = tagContents[fileIndex]!;
       if (contentBefore === null) {
         for (const op of ops) items.push({ issueId: op.issueId, ok: false, reason: 'file-not-found', filePath });
         continue;
       }
       if (fileIndex > 0) await yieldToEventLoop();

       // ONE parse per file; member ops and top-level ops run as two batches
       // against it. Tag plans contain only insertions, which never conflict.
       const parsed = parseSource(filePath, contentBefore);
       const memberIndexes: number[] = [];
       const topIndexes: number[] = [];
       ops.forEach((op, i) => (op.parentSymbol !== undefined ? memberIndexes : topIndexes).push(i));
       const memberOut = insertMemberPublicTagBatch(parsed, contentBefore, memberIndexes.map((i) => ops[i]!));
       const topOut = insertPublicTagBatch(parsed, contentBefore, topIndexes.map((i) => ops[i]!));

       const resultByOp = new Array<BatchOpResult>(ops.length);
       memberIndexes.forEach((original, j) => { resultByOp[original] = memberOut.results[j]!; });
       topIndexes.forEach((original, j) => { resultByOp[original] = topOut.results[j]!; });

       const edits = [...memberOut.edits, ...topOut.edits];
       const newContent = edits.length > 0 ? applyEdits(contentBefore, edits) : contentBefore;
       ops.forEach((op, i) => {
         const result = resultByOp[i]!;
         items.push(
           result.ok
             ? { issueId: op.issueId, ok: true, filePath }
             : { issueId: op.issueId, ok: false, reason: result.reason, filePath },
         );
       });

       if (newContent !== contentBefore) {
         const patch: FilePatch = { filePath, kind: 'modify', hashBefore: hashContent(contentBefore), contentAfter: newContent };
         patches.push(patch);
         diffs.push({ filePath, diff: renderDiff(patch, contentBefore) });
       }
     }
     ```

     Note: the `TagOp` interface stays (it structurally satisfies `SourceOp`, its extra `issueId` field is ignored by the batch functions). Keep the enumMembers/namespaceMembers "tag the MEMBER's own line" comment where it is.

- [ ] Run `pnpm test tests/unit/compiler-batch.test.ts` — expected: PASS (all 6 tests).
- [ ] Run `pnpm test` — expected: ENTIRE suite green, `tests/unit/compiler.test.ts` untouched and passing (this is the parity proof for: descending-pos test, failure-mid-chain test, duplicates partial-failure test, delete-file precedence, dep chaining, all ignore-plan tests).
- [ ] Verify shrinkage: `wc -l src/fix/compiler.ts` — expected: well under 300 lines.
- [ ] Verify no dead strings: `grep -rn "unsupported fix mode\|runSourceChain\|runSourceTransform" src tests` — expected: no hits.
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `feat: compile fix/ignore plans with one parse and one MagicString per file (#32)`

---

## Post-implementation verification (before finishing the branch)

- [ ] `pnpm test` — full suite green.
- [ ] `pnpm run typecheck` — clean across all three tsconfigs.
- [ ] `pnpm run build` — compiles.
- [ ] `grep -rn "from '../fix/compiler.js'\|from './compiler.js'\|from '../../src/fix/compiler.js'" src client tests` — only `compileFixPlan`/`FixSelection` consumers remain (`src/server/routes-fix.ts`, `tests/unit/compiler.test.ts`, `tests/unit/compiler-batch.test.ts`).
- [ ] Manual smoke (optional but recommended): run the app against a fixture project, select many issues in one file including one enum's several members, preview — one patch per file, diff sane, no event-loop freeze.

## Behavioral notes pinned by this plan (for reviewers)

- Old op-to-op chaining could FAIL the second of two strip-export ops on one multi-declarator statement (the symbol was no longer exported after op 1); the batch dedupes the identical edit and both ops succeed. Multi-op behavior is defined by the new tests; single-op behavior is pinned unchanged by the pre-existing suite.
- Emptying an enum op-by-op used to leave `export enum Foo {\n  \n}\n`; the batch reproduces exactly that (whole-shell removal is NOT a remove-member behavior).
- `PlanItem` ordering within a plan may differ (no longer descending-pos); nothing reads item order — all tests look items up by issueId.
