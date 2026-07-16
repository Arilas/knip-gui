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

// Removes the entire declaration statement (including attached leading JSDoc/comments,
// class decorators, and the trailing newline) rather than just unexporting it:
// - direct `export const/function/class/type/interface/enum X` -> delete the whole
//   `ExportNamedDeclaration` statement (decorators above the `export` keyword are
//   swept into the range via the site's `deleteStart`, and comment attachment is
//   computed from there so a JSDoc above the decorators goes too).
// - one declarator of a multi-declarator `export const a = 1, b = 2;` -> delete only
//   the flagged declarator (comma hygiene as for export lists), NOT the live
//   siblings; when it's the statement's sole declarator, delete the whole statement.
// - `export default ...` -> delete the whole `ExportDefaultDeclaration` statement
//   (named or anonymous — deleteDeclaration always removes the value, unlike
//   stripExport which keeps a named default's value alive).
// - `export { a, b }` list binding -> delete the local declaration (if any — a
//   re-export has none) AND remove it from the list (emptying the list removes the
//   whole statement, same comma-hygiene rule as stripExport).
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
