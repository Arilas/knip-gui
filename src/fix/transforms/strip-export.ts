import MagicString from 'magic-string';
import { locateExport, parseSource, removeListSpecifier, type TransformInput, type TransformResult } from './source.js';

// Mirrors `knip --fix`'s strip-export behavior:
// - `export const/function/class/type/interface/enum X` -> remove the `export ` keyword.
// - `export { a, b }` -> remove the binding (+ comma); an emptied list removes the
//   whole statement (also applies to `export { x } from '...'` re-exports).
// - `export default <expr|function|class>` -> remove the `export default ` prefix
//   when the declaration is named; otherwise remove the whole statement (an anonymous
//   default's value is dead code without its export).
export function stripExport(input: TransformInput): TransformResult {
  const { filePath, content, symbol, pos } = input;
  const { program } = parseSource(filePath, content);
  const located = locateExport(program, symbol, pos);
  if ('error' in located) return { ok: false, reason: located.error };
  const site = located.site;

  const s = new MagicString(content);
  if (site.kind === 'declaration') {
    s.remove(site.exportStart, site.declStart);
  } else if (site.kind === 'specifier') {
    if (site.specifiers.length === 1) {
      s.remove(site.statementStart, site.statementEnd);
    } else {
      removeListSpecifier(s, site.specifiers, site.index);
    }
  } else {
    if (site.isNamed) {
      s.remove(site.statementStart, site.declStart);
    } else {
      s.remove(site.statementStart, site.statementEnd);
    }
  }

  return { ok: true, newContent: s.toString() };
}
