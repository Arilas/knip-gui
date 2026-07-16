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

// Removes ONE aliasing binding from knip's `duplicates` report — the
// non-canonical name in a duplicate-export group (e.g. `dupeAlias` in
// `export const dupeAlias = dupeSource;`, or `y` in `export { x as y }`) —
// while leaving the original/canonical declaration (`dupeSource` / `x`)
// completely untouched. The plan compiler (Task 6) passes `symbol`/`pos` from
// `duplicateMembers[i]` for i >= 1 (never the group's first/canonical member,
// per task-1-report.md's "remove-duplicate must target duplicateMembers[1..]"
// note).
//
// Ground truth (task-1-report.md): knip's `duplicates` detector only fires for
// `export const b = a` / `export default a` aliasing of an existing local
// export (the "declaration"/"default" ExportSite kinds below) — plain
// `export { a as b }` never produces a `duplicates` issue in knip 6.26.0. The
// `export { x as y }` specifier form is still handled here (per the brief)
// since other projects/future knip versions may produce duplicates that way.
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
