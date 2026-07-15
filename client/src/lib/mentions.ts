// Pure helpers for the Packages page's row-click preview panel (Task Q, #24):
// counting how many times a dependency NAME appears in a file's raw content
// (the "N other mentions" line below CodePane's badge) and locating the
// declaration line CodePane should scroll to.
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
import type { IssueType } from '../../../src/core/types.js';

export function countMentions(content: string, name: string): number {
  // An empty name would make `"${name}"` the two-character string `""`,
  // which matches every empty JSON string in the file (e.g. `"": ""`) —
  // meaningless as a "mentions" count, so treat it as zero rather than
  // returning a number computed from an accidental match.
  if (!name) return 0;
  return content.split(`"${name}"`).length - 1;
}

/**
 * package.json section key(s) a dependency-shaped issue's declaration lives
 * under, for findDeclarationLine's section-scoped scan (Task Q review,
 * IMPORTANT 2: a name listed in BOTH dependencies and devDependencies must
 * highlight the line inside the issue's OWN section, which a section-blind
 * first-match scan gets wrong for whichever section comes second).
 *
 * knip's `optionalPeerDependencies` entries are declared in the
 * `peerDependencies` block (marked optional via `peerDependenciesMeta`), so
 * that type maps to `peerDependencies`. `binaries` is deliberately unmapped:
 * a binary is a command exposed by some dependency's `bin`, not a key under
 * one fixed section — callers pass `undefined` and get the whole-file scan.
 */
export const PACKAGE_JSON_SECTIONS: Partial<Record<IssueType, readonly string[]>> = {
  dependencies: ['dependencies'],
  devDependencies: ['devDependencies'],
  optionalPeerDependencies: ['peerDependencies'],
};

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
 * comment). When `sections` is given (PACKAGE_JSON_SECTIONS[issue.type]),
 * the scan is CONFINED to those objects: a candidate `"section":` key only
 * ANCHORS the scan if its VALUE opens an object — first non-whitespace after
 * the colon is `{`, on the same line or after whitespace-only continuation
 * (task Q review 2: a nested decoy like `"scripts": { "dependencies": "node
 * check-deps.js" }`, or a non-object section value, previously hijacked the
 * anchor and — since no brace ever opened — leaked token matches from
 * ANYWHERE later in the file). A candidate that fails the shape check is
 * skipped and the search continues FORWARD to the next candidate, so a
 * decoy can't shadow a real later section either. From the accepted anchor's
 * opening `{`, brace depth is walked until it returns to zero, matching the
 * name only inside that region — including the brace's own line (single-line
 * sections like the e2e fixture's `"dependencies": { "left-pad": "1.3.0" }`)
 * and EXCLUDING anything after the section's closing `}`. No fall-through to
 * a whole-file match when a section scan misses: a wrong line is worse than
 * no line (CodePane just shows its banner instead). Accepted limitation,
 * documented rather than handled: literal `{`/`}` characters inside JSON
 * string values would skew the depth count — they effectively never occur
 * in dependency names/semver ranges.
 */
export function findDeclarationLine(
  content: string,
  name: string,
  sections?: readonly string[],
): number | undefined {
  if (!name) return undefined;
  const token = `"${name}"`;
  const lines = content.split('\n');

  if (!sections || sections.length === 0) {
    const index = lines.findIndex((line) => line.includes(token));
    return index === -1 ? undefined : index + 1;
  }

  for (const section of sections) {
    const header = `"${section}"`;
    // Walk every candidate anchor in order, not just the first: nested keys
    // that merely LOOK like the section (a scripts entry named
    // "dependencies") fail the value-shape check below and must not shadow a
    // real section further down. The exact quoted token also means
    // `"dependencies"` can never match inside `"devDependencies"` (the `d`
    // there is preceded by `D`, not `"`).
    for (let start = 0; start < lines.length; start++) {
      const headerLine = lines[start]!;
      const at = headerLine.indexOf(header);
      if (at === -1) continue;
      // Must be a KEY: optional whitespace then `:` right after the token.
      const colon = /^\s*:/.exec(headerLine.slice(at + header.length));
      if (!colon) continue;

      // Anchor shape check: the key's value must OPEN AN OBJECT. Skip
      // whitespace after the colon — across whitespace-only line breaks too
      // (`"dependencies":\n  {`) — and require the first real character to
      // be `{`. Anything else (string, number, array…) is not a section;
      // keep searching for the next candidate.
      let braceLine = start;
      let bracePos = at + header.length + colon[0].length;
      while (braceLine < lines.length) {
        const l = lines[braceLine]!;
        while (bracePos < l.length && /\s/.test(l[bracePos]!)) bracePos += 1;
        if (bracePos < l.length) break;
        braceLine += 1;
        bracePos = 0;
      }
      if (braceLine >= lines.length || lines[braceLine]![bracePos] !== '{') continue;

      // Real section found: walk brace depth from its opening `{`. Matching
      // starts AT the brace (`entered` gates it — nothing before the object
      // actually opens can match, per review), and the region never includes
      // anything before the brace on its own line (a `"name": "left-pad"`
      // key preceding a single-line section) or after the closing `}`.
      let depth = 0;
      let entered = false;
      for (let i = braceLine; i < lines.length; i++) {
        const line = lines[i]!;
        const from = i === braceLine ? bracePos : 0;
        let end = line.length;
        let closed = false;
        for (let j = from; j < line.length; j++) {
          const ch = line[j];
          if (ch === '{') {
            depth += 1;
            entered = true;
          } else if (ch === '}') {
            depth -= 1;
            if (entered && depth === 0) {
              end = j;
              closed = true;
              break;
            }
          }
        }
        if (entered && line.slice(from, end).includes(token)) return i + 1;
        if (closed) break;
      }
      // A validated section was scanned and the name wasn't in it. Stop for
      // this key — valid JSON can't have a second section under the same
      // top-level key, and falling through to later text would reintroduce
      // exactly the out-of-section leak this scan exists to prevent.
      break;
    }
  }
  return undefined;
}
