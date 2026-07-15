// Pure-helper tests for the Packages page's row-click preview panel (Task Q,
// #24): countMentions locates OTHER occurrences of a dependency name in the
// raw package.json content shown alongside CodePane's own badge/line. Pinned
// here as a substring-vs-token test: 'pad' must NOT match inside 'left-pad',
// which a naive `content.includes(name)` scan would get wrong.
import { describe, expect, it } from 'vitest';
import { countMentions, findDeclarationLine } from '../../client/src/lib/mentions.js';

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

  it('finds the first match when the name appears in multiple dependency blocks', () => {
    const content = ['{', '  "dependencies": { "left-pad": "1.3.0" },', '  "devDependencies": { "left-pad": "1.3.0" }', '}'].join(
      '\n',
    );
    expect(findDeclarationLine(content, 'left-pad')).toBe(2);
  });
});
