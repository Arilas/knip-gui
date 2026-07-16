# Compiler-Shape Batch Design (#32 + #42)

Issues: #32 (fix-plan compilation re-parses the file once per issue) and #42
(generic op-chain + move ignore-plan compilation into src/ignore).

## Problem

Every source transform (`stripExport`, `deleteDeclaration`, `removeDuplicate`,
`removeMember`, `insertPublicTag`, `insertMemberPublicTag`) parses the whole
file with oxc and materializes a full `MagicString.toString()` per op, and the
compiler chains content op-to-op (k ops on one file = k parses + k full-string
rebuilds, all synchronous — 10-30s event-loop stalls on "select all" over a
big barrel file). Ignore-plan compilation also lives in `src/fix/compiler.ts`
while importing everything from `src/ignore/` (backwards dependency arrow).

## Design

### 1. Batch transform contract (the #32 core)

New shared types in `src/fix/transforms/source.ts`:

```ts
/** A removal ([start,end) deleted) or an insertion (start===end, text added). */
export interface SourceEdit { start: number; end: number; text?: string }
export type BatchOpResult = { ok: true } | { ok: false; reason: string };
```

Each transform module gains a **batch function** that receives ONE parse and
the ORIGINAL content plus ALL of that file's ops for its mode, and returns
per-op results plus edits computed against the original offsets:

```ts
stripExportBatch(parsed: ParsedSource, content: string, ops: SourceOp[])
  : { results: BatchOpResult[]; edits: SourceEdit[] }
// likewise deleteDeclarationBatch, removeDuplicateBatch, removeMemberBatch,
// insertPublicTagBatch, insertMemberPublicTagBatch
```

Because every op now locates against the ORIGINAL content, **every op uses its
own `pos`** (the old "only idx===0 gets pos" chaining rule disappears — knip's
positions are all valid against the original bytes).

**List coordination lives inside each batch function** (it owns the list
knowledge): when this mode's ops for one file cover multiple items of the same
comma-separated list (export specifiers, variable declarators, enum members,
namespace-body members), the batch function computes the combined edits itself:
- subset of a list → generalized `removeListItems(items, sortedIndices)`
  comma-hygiene (non-trailing removed item: `[cur.start, next.start)`;
  trailing run: `[lastSurvivor.end, lastRemoved.end)`); enum members keep their
  comment-aware boundary variant.
- ALL items of a list → the whole-statement removal that mode would apply
  (with comment/newline expansion where the old chained path did it).
- Overload sets (`findExportedFunctionSites`) already handle their multi-
  statement sweep inside one op — unchanged.

### 2. Compiler applies edits once per file

`compileFixPlan` / the tag-op half of `compileIgnorePlan`: per file —
read (all files via `Promise.all`), `parseSource` ONCE, group ops by mode,
call each mode's batch function, then:

- **Conflict rule:** merge all modes' removal edits sorted by start; if an edit
  from mode B overlaps an already-accepted edit, every op that produced the
  overlapping edit fails with reason `'conflicts with another selected fix in
  the same statement'` and its edits are dropped (deterministic: modes are
  processed in a fixed order, ops within a mode already coordinated).
  Insertions never conflict (tag plans contain only insertions).
- Apply accepted edits to ONE `MagicString` (`remove(start,end)` /
  `appendLeft(start, text)`), ONE `toString()`, then hash/diff exactly as
  today. `await setImmediate` between files to yield the event loop.
- PlanItems: per issue, ok only if ALL its ops ok (duplicates explode into
  multiple ops as today); `filePath` semantics unchanged (from the #39 batch).

### 3. Old single-op API preserved as thin wrappers (regression harness)

`stripExport(input: TransformInput): TransformResult` etc. remain, implemented
as `parse → <mode>Batch(parsed, content, [op]) → apply edits → {ok, newContent}`.
**The entire existing transform/compiler test suite must pass unchanged** —
that is the behavioral spec for the single-op paths. New tests cover the
multi-op cases: emptying an export list op-by-op removes the whole statement;
adjacent declarators; multiple enum members (incl. trailing-comment hygiene);
multiple namespace members incl. the last; overload set + another export in
one file; the cross-mode conflict rule; duplicates group multi-alias.

### 4. Structural moves (the #42 half)

- `src/fix/plan.ts`: `FixPlan`, `PlanItem`, `newPlanId`, `readFileOrNull`
  move here; all importers updated (client `api.ts` cross-root import too).
  No back-compat re-exports (knip dogfooding would flag them).
- `src/ignore/compile.ts`: `compileIgnorePlan` + `compileRemoveIgnoresPlan`
  move here (dependency arrow becomes ignore → fix/plan primitives only).
  `src/fix/compiler.ts` keeps only the fix-plan compiler and shrinks well
  under 300 lines.
- Small shared `chainTextEdits(contentBefore, ops, step)` helper for the two
  remaining genuinely-sequential text-edit loops (package.json dep ops,
  knip-config edits) — they re-parse tiny JSON docs per edit, which is fine;
  batching THOSE parses is #36, out of scope here.

## Non-goals

- Worker-thread parsing, knip-stdout streaming (#33/#36 territory).
- Batched `addIgnores` single-parse (#36).
- Any change to preview/apply wire shapes, PlanStore, or routes.

## Risks

- Behavior parity for exotic multi-op selections — mitigated by keeping every
  existing test green through the wrappers plus the new multi-op matrix.
- magic-string overlap edge cases — mitigated by the compiler's own interval
  merge/conflict rule (never hand magic-string overlapping removals).
