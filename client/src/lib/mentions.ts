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
 * the scan is CONFINED to those top-level objects: find the `"section":`
 * header, then walk brace depth from its value's opening `{` until it
 * returns to zero, matching the name only inside that region — including the
 * header line itself after the key (single-line sections like the e2e
 * fixture's `"dependencies": { "left-pad": "1.3.0" }`) and EXCLUDING
 * anything on the closing line after the section's final `}`. No
 * fall-through to a whole-file match when a section scan misses: a wrong
 * line is worse than no line (CodePane just shows its banner instead).
 * Accepted limitation, documented rather than handled: literal `{`/`}`
 * characters inside JSON string values would skew the depth count — they
 * effectively never occur in dependency names/semver ranges.
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
    // The header must be a KEY (`"deps"  :`), not a value — and the exact
    // quoted token means `"dependencies"` can never match inside
    // `"devDependencies"` (the `d` there is preceded by `D`, not `"`).
    const start = lines.findIndex((line) => {
      const at = line.indexOf(header);
      return at !== -1 && /^\s*:/.test(line.slice(at + header.length));
    });
    if (start === -1) continue;

    let depth = 0;
    let entered = false;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]!;
      // On the header line only the part AFTER the key participates —
      // anything before it belongs to a different key (`"name": "left-pad"`
      // preceding the dependencies key must not match).
      const from = i === start ? line.indexOf(header) + header.length : 0;
      // Walk braces to find where (if anywhere) on this line the section
      // closes; the name is only matched up to that point.
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
      if (line.slice(from, end).includes(token)) return i + 1;
      if (closed) break;
    }
  }
  return undefined;
}
