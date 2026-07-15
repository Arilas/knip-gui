// Pure-helper tests for the Packages page's row-click preview panel (Task Q,
// #24): countMentions locates OTHER occurrences of a dependency name in the
// raw package.json content shown alongside CodePane's own badge/line. Pinned
// here as a substring-vs-token test: 'pad' must NOT match inside 'left-pad',
// which a naive `content.includes(name)` scan would get wrong.
import { describe, expect, it } from 'vitest';
import { countMentions, findDeclarationLine, PACKAGE_JSON_SECTIONS } from '../../client/src/lib/mentions.js';

describe('countMentions', () => {
  it('counts exact double-quoted occurrences of the name', () => {
    const content = '{\n  "dependencies": { "left-pad": "1.3.0" }\n}\n';
    expect(countMentions(content, 'left-pad')).toBe(1);
  });

  it('does not match a name that is only a substring of a longer token', () => {
    // 'pad' is a substring of 'left-pad', but the quote immediately before
    // 'pad' in the source is preceded by '-', not '"' — the exact-token
    // match must not count it.
    const content = '{ "dependencies": { "left-pad": "1.3.0" } }';
    expect(countMentions(content, 'pad')).toBe(0);
  });

  it('counts every distinct occurrence across multiple dependency blocks', () => {
    const content = [
      '{',
      '  "dependencies": { "left-pad": "1.3.0" },',
      '  "devDependencies": { "left-pad": "1.3.0" }',
      '}',
    ].join('\n');
    expect(countMentions(content, 'left-pad')).toBe(2);
  });

  it('handles scoped package names without regex-escaping surprises', () => {
    const content = '{ "dependencies": { "@scope/left-pad": "1.0.0", "@scope/left-pad-extra": "2.0.0" } }';
    expect(countMentions(content, '@scope/left-pad')).toBe(1);
  });

  it('returns 0 for a name with no occurrences', () => {
    const content = '{ "dependencies": { "left-pad": "1.3.0" } }';
    expect(countMentions(content, 'right-pad')).toBe(0);
  });

  it('returns 0 for an empty name rather than counting bare quote pairs', () => {
    const content = '{ "": "", "left-pad": "1.3.0" }';
    expect(countMentions(content, '')).toBe(0);
  });
});

describe('findDeclarationLine', () => {
  it('returns the 1-indexed line of the first exact-token match', () => {
    const content = '{\n  "name": "fixture",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n';
    expect(findDeclarationLine(content, 'left-pad')).toBe(3);
  });

  it('does not match a name that is only a substring of a longer token', () => {
    const content = '{\n  "dependencies": { "left-pad": "1.3.0" }\n}\n';
    expect(findDeclarationLine(content, 'pad')).toBeUndefined();
  });

  it('returns undefined when the name never appears', () => {
    const content = '{ "dependencies": { "left-pad": "1.3.0" } }';
    expect(findDeclarationLine(content, 'right-pad')).toBeUndefined();
  });

  it('returns undefined for an empty name', () => {
    const content = '{ "dependencies": { "left-pad": "1.3.0" } }';
    expect(findDeclarationLine(content, '')).toBeUndefined();
  });

  it('finds the first match when the name appears in multiple dependency blocks (no sections given)', () => {
    const content = ['{', '  "dependencies": { "left-pad": "1.3.0" },', '  "devDependencies": { "left-pad": "1.3.0" }', '}'].join(
      '\n',
    );
    expect(findDeclarationLine(content, 'left-pad')).toBe(2);
  });

  // Section-aware scanning (Task Q review, IMPORTANT 2): a name present in
  // BOTH dependencies and devDependencies must resolve to the line inside
  // the SECTION the issue belongs to, not blindly the first match — the
  // multi-line fixture below is exactly the case the section-blind version
  // got wrong for the devDependencies issue.
  const MULTI_SECTION = [
    '{', //                                line 1
    '  "name": "left-pad-consumer",', //   line 2 — decoy: name token also
    //                                     appears OUTSIDE any dep section
    '  "dependencies": {', //              line 3
    '    "left-pad": "1.3.0"', //          line 4
    '  },', //                             line 5
    '  "devDependencies": {', //           line 6
    '    "left-pad": "1.3.0",', //         line 7
    '    "other": "2.0.0"', //             line 8
    '  }', //                              line 9
    '}', //                                line 10
  ].join('\n');

  it('resolves the dependencies-section line when scoped to dependencies', () => {
    expect(findDeclarationLine(MULTI_SECTION, 'left-pad', ['dependencies'])).toBe(4);
  });

  it('resolves the devDependencies-section line when scoped to devDependencies', () => {
    expect(findDeclarationLine(MULTI_SECTION, 'left-pad', ['devDependencies'])).toBe(7);
  });

  it('does not leak matches from other sections: name absent from the scoped section is undefined', () => {
    // "other" only exists in devDependencies — a dependencies-scoped scan
    // must NOT fall through to it.
    expect(findDeclarationLine(MULTI_SECTION, 'other', ['dependencies'])).toBeUndefined();
  });

  it('returns undefined when the scoped section is absent from the file', () => {
    expect(findDeclarationLine(MULTI_SECTION, 'left-pad', ['peerDependencies'])).toBeUndefined();
  });

  it('handles a single-line section (the e2e fixture shape)', () => {
    const content = '{\n  "name": "fixture-single",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n';
    expect(findDeclarationLine(content, 'left-pad', ['dependencies'])).toBe(3);
  });

  it('does not confuse the devDependencies header with a dependencies section scan', () => {
    // "devDependencies" does NOT contain the exact quoted token
    // `"dependencies"` (the 'd' is preceded by 'D', not '"') — a
    // dependencies-scoped scan over a devDeps-only file finds no section.
    const content = '{\n  "devDependencies": { "left-pad": "1.3.0" }\n}\n';
    expect(findDeclarationLine(content, 'left-pad', ['dependencies'])).toBeUndefined();
  });

  it('does not match a name that appears on the section header line but before the header key', () => {
    // Pathological single-line JSON: the name appears earlier on the SAME
    // line the section header sits on — only the region after the section's
    // opening brace may match.
    const content = '{ "name": "left-pad", "dependencies": { "other": "1.0.0" } }';
    expect(findDeclarationLine(content, 'left-pad', ['dependencies'])).toBeUndefined();
  });

  it('does not match a name that appears after the scoped section closes on the same line', () => {
    const content = '{ "dependencies": { "other": "1.0.0" }, "left-pad": "9.9.9" }';
    expect(findDeclarationLine(content, 'left-pad', ['dependencies'])).toBeUndefined();
  });
});

describe('PACKAGE_JSON_SECTIONS', () => {
  it('maps each dependency-shaped issue type to its package.json section', () => {
    expect(PACKAGE_JSON_SECTIONS.dependencies).toEqual(['dependencies']);
    expect(PACKAGE_JSON_SECTIONS.devDependencies).toEqual(['devDependencies']);
    // knip's optionalPeerDependencies live in package.json's
    // peerDependencies block (flagged optional via peerDependenciesMeta).
    expect(PACKAGE_JSON_SECTIONS.optionalPeerDependencies).toEqual(['peerDependencies']);
    // binaries deliberately unmapped: a binary is a command exposed by some
    // dependency's `bin`, not a key under one fixed section — callers fall
    // back to the whole-file scan.
    expect(PACKAGE_JSON_SECTIONS.binaries).toBeUndefined();
  });
});
