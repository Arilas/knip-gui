// Pure helper for the Packages page's row-click preview panel (Task Q, #24):
// counts how many times a dependency NAME appears in a file's raw content,
// so the panel can show "N other mentions" below CodePane's own badge/line.
//
// Matching rule: an exact double-quoted JSON string token (`"name"`), found
// via a literal substring search — NOT a regex, and NOT a bare
// `content.includes(name)`. Two things this buys:
//  - No substring soup: searching `"pad"` never matches inside `"left-pad"`
//    (the character before "pad" there is '-', not a quote), whereas a plain
//    `content.includes(name)` would false-positive on every dependency whose
//    name happens to be a suffix/infix of another.
//  - No regex-escaping footguns: package names routinely contain characters
//    that are regex metacharacters (`.`, `/`, `@scope/name`) — a literal
//    `String#split` search sidesteps needing to escape any of them.
// This is deliberately package.json-shaped (double-quoted keys/values): every
// issue type PackagesPage shows (PACKAGE_TYPES) points at a workspace's
// package.json, which is always double-quoted JSON, so there's no need to
// also handle single-quoted or unquoted source-code occurrences here.
export function countMentions(content: string, name: string): number {
  // An empty name would make `"${name}"` the two-character string `""`,
  // which matches every empty JSON string in the file (e.g. `"": ""`) —
  // meaningless as a "mentions" count, so treat it as zero rather than
  // returning a number computed from an accidental match.
  if (!name) return 0;
  return content.split(`"${name}"`).length - 1;
}

/**
 * Locates a dependency's declaration line in raw file content, 1-indexed to
 * match knip's own `Issue.line` convention (and CodePane's `.line` DOM-index
 * math — see lib/highlighter.ts's issueLines: `lineNo = idx + 1`).
 *
 * Exists because knip 6's actual dependency-shaped JSON carries no
 * line/col/pos at all — confirmed by running `knip --reporter json` directly
 * against tests/fixtures/single: `{"dependencies":[{"name":"left-pad"}]}`,
 * no position field (this matches normalize.ts's own symbolsFor doc comment,
 * `{name}` with no position, for dependencies/devDependencies/
 * optionalPeerDependencies/unlisted/unresolved/binaries/catalog — despite
 * this task's own brief assuming a `line` was already present). PackagesPage
 * uses this to synthesize a `line` on a CLONE of the issue before handing it
 * to CodePane, so CodePane's existing gutter-badge/auto-scroll/pulse — which
 * is entirely keyed off `issue.line` — works for real instead of falling
 * back to its line-less whole-file banner.
 *
 * Same exact-token double-quoted matching rule as countMentions (see its
 * comment) — checked per-line here instead of counted globally.
 */
export function findDeclarationLine(content: string, name: string): number | undefined {
  if (!name) return undefined;
  const index = content.split('\n').findIndex((line) => line.includes(`"${name}"`));
  return index === -1 ? undefined : index + 1;
}
