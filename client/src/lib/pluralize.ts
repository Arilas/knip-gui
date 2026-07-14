// Pure count+noun pluralization for issue-type summaries (Task 2, v0.3
// review-page groundwork): shared by SelectionDock's count/per-type badges,
// selection.ts's summaryByType (feeding commit messages), and later the
// Review page's rail/commit copy — so "1 file" vs "2 files" (and "1 export"
// vs "3 exports") never drifts between call sites.
//
// Deliberately NOT built on lib/filters.ts's typeLabel() ("Unused exports",
// "Duplicate exports") — those are always-plural CATEGORY headings (chip/
// stat-tile captions), not count nouns: pluralizing them would double-
// pluralize ("2 Unused exportss") or read oddly at count 1 ("1 Unused
// exports"). This module owns its own singular noun per IssueType instead.
import type { IssueType } from '../../../src/core/types.js';

// Singular noun for each IssueType — what one one of these actually *is*,
// not the category label. `unresolved`/`unlisted` read like standalone type
// names in lib/filters.ts, but as a countable noun they need their object
// spelled out ("1 unresolved import", not "1 unresolved") for the sentence
// to parse.
const SINGULAR_NOUN: Record<IssueType, string> = {
  files: 'file',
  exports: 'export',
  nsExports: 'namespace export',
  types: 'type',
  nsTypes: 'namespace type',
  enumMembers: 'enum member',
  namespaceMembers: 'namespace member',
  duplicates: 'duplicate export',
  dependencies: 'dependency',
  devDependencies: 'dev dependency',
  optionalPeerDependencies: 'peer dependency',
  unlisted: 'unlisted dependency',
  unresolved: 'unresolved import',
  binaries: 'binary',
  catalog: 'catalog entry',
  cycles: 'import cycle',
};

// Regular-English pluralization of the noun's LAST word only — every noun
// above is either one word or "<qualifier> <noun>" (e.g. "enum member", "dev
// dependency"), so only the trailing word ever needs inflecting. A trailing
// consonant + 'y' becomes '-ies' (dependency -> dependencies, binary ->
// binaries, entry -> entries); a sibilant ending (s/x/z/ch/sh) takes '-es';
// everything else just takes '-s'. This covers every noun SINGULAR_NOUN
// defines — it is not a general-purpose English pluralizer.
function pluralizeNoun(noun: string): string {
  const lastSpace = noun.lastIndexOf(' ');
  const head = lastSpace === -1 ? '' : noun.slice(0, lastSpace + 1);
  const word = lastSpace === -1 ? noun : noun.slice(lastSpace + 1);

  const precedingChar = word.length >= 2 ? word[word.length - 2]!.toLowerCase() : '';
  const precedingIsConsonant = precedingChar !== '' && !'aeiou'.includes(precedingChar);
  if (word.endsWith('y') && precedingIsConsonant) return `${head}${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${head}${word}es`;
  return `${head}${word}s`;
}

/**
 * "1 export" / "3 exports" / "1 file" / "2 dependencies" / "1 unresolved
 * import" — the shared count+noun formatter for selection summaries, count
 * badges, and commit messages. `count === 1` uses the bare singular noun;
 * every other count (including 0) pluralizes.
 */
export function pluralizeType(count: number, type: IssueType): string {
  const noun = SINGULAR_NOUN[type];
  return `${count} ${count === 1 ? noun : pluralizeNoun(noun)}`;
}
