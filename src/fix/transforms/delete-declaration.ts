import MagicString from 'magic-string';
import {
  expandEndWithTrailingNewline,
  expandStartWithLeadingComments,
  findExportedFunctionSites,
  findTopLevelDeclarationSpan,
  locateExport,
  parseSource,
  removeListItem,
  type TransformInput,
  type TransformResult,
} from './source.js';

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
export function deleteDeclaration(input: TransformInput): TransformResult {
  const { filePath, content, symbol, pos } = input;
  const { program, comments } = parseSource(filePath, content);
  const located = locateExport(program, symbol, pos);
  if ('error' in located) return { ok: false, reason: located.error };
  const site = located.site;

  const s = new MagicString(content);
  const removeWithComments = (start: number, end: number): void => {
    const from = expandStartWithLeadingComments(content, comments, start);
    const to = expandEndWithTrailingNewline(content, end);
    s.remove(from, to);
  };

  if (site.kind === 'declaration') {
    // Exported function overload set: delete every signature and the implementation,
    // not just the located one, or the leftover statements reference a now-missing
    // export (and fail TS2383 if any `export` survives).
    const fnSites = findExportedFunctionSites(program, symbol);
    if (fnSites.length > 1) {
      for (const fn of fnSites) removeWithComments(fn.deleteStart, fn.statementEnd);
      return { ok: true, newContent: s.toString() };
    }
    if (site.declarators && site.declarators.length > 1 && site.declaratorIndex !== undefined) {
      removeListItem(s, site.declarators, site.declaratorIndex);
    } else {
      removeWithComments(site.deleteStart, site.statementEnd);
    }
  } else if (site.kind === 'default') {
    removeWithComments(site.statementStart, site.statementEnd);
  } else {
    if (!site.isReexport) {
      const localSpan = findTopLevelDeclarationSpan(program, site.localName);
      if (localSpan) removeWithComments(localSpan.start, localSpan.end);
    }
    if (site.specifiers.length === 1) {
      removeWithComments(site.statementStart, site.statementEnd);
    } else {
      removeListItem(s, site.specifiers, site.index);
    }
  }

  return { ok: true, newContent: s.toString() };
}
