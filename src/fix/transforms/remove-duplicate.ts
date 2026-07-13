import MagicString from 'magic-string';
import {
  expandEndWithTrailingNewline,
  expandStartWithLeadingComments,
  locateExport,
  parseSource,
  removeListItem,
  type TransformInput,
  type TransformResult,
} from './source.js';

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
export function removeDuplicate(input: TransformInput): TransformResult {
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
    // `export const dupeAlias = dupeSource;` — the aliasing statement IS the
    // duplicate; remove it whole (comments + trailing newline). Does not reuse
    // deleteDeclaration's multi-declarator/decorator machinery: per the ground
    // truth above, a duplicate alias is always a single, undecorated
    // `export const`.
    removeWithComments(site.deleteStart, site.statementEnd);
  } else if (site.kind === 'default') {
    // `export default dupeSource;` aliasing form — remove the whole statement;
    // a default export has no separate local declaration to preserve.
    removeWithComments(site.statementStart, site.statementEnd);
  } else {
    // `export { dupeSource as dupeAlias }` — remove ONLY the specifier
    // (comma-hygiene; whole statement if it empties). Unlike
    // deleteDeclaration's specifier branch, this deliberately does NOT delete
    // `site.localName`'s declaration: for a duplicate alias, `localName` is the
    // CANONICAL original (`dupeSource`) — the thing being kept, not the
    // duplicate being removed.
    if (site.specifiers.length === 1) {
      removeWithComments(site.statementStart, site.statementEnd);
    } else {
      removeListItem(s, site.specifiers, site.index);
    }
  }

  return { ok: true, newContent: s.toString() };
}
