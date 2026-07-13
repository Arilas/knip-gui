import MagicString from 'magic-string';
import {
  expandEndWithTrailingNewline,
  expandStartWithLeadingComments,
  findTopLevelDeclarationSpan,
  locateExport,
  parseSource,
  removeListSpecifier,
  type TransformInput,
  type TransformResult,
} from './source.js';

// Removes the entire declaration statement (including attached leading JSDoc/comments
// and the trailing newline) rather than just unexporting it:
// - direct `export const/function/class/type/interface/enum X` -> delete the whole
//   `ExportNamedDeclaration` statement.
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
    removeWithComments(site.exportStart, site.statementEnd);
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
      removeListSpecifier(s, site.specifiers, site.index);
    }
  }

  return { ok: true, newContent: s.toString() };
}
