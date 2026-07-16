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

// Mirrors `knip --fix`'s strip-export behavior:
// - `export const/function/class/type/interface/enum X` -> remove the `export ` keyword.
// - `export { a, b }` -> remove the binding (+ comma); an emptied list removes the
//   whole statement (also applies to `export { x } from '...'` re-exports).
// - `export default <expr|function|class>` -> remove the `export default ` prefix
//   when the declaration is named; otherwise remove the whole statement (an anonymous
//   default's value is dead code without its export).
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
