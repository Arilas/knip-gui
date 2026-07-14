import { describe, expect, it } from 'vitest';
import type { IssueType } from '../../src/core/types.js';
import { pluralizeType } from '../../client/src/lib/pluralize.js';

describe('pluralizeType', () => {
  it('pluralizes regular nouns with a trailing s', () => {
    expect(pluralizeType(1, 'exports')).toBe('1 export');
    expect(pluralizeType(3, 'exports')).toBe('3 exports');
    expect(pluralizeType(1, 'files')).toBe('1 file');
    expect(pluralizeType(2, 'files')).toBe('2 files');
  });

  it('pluralizes multi-word nouns on the trailing word only', () => {
    expect(pluralizeType(1, 'enumMembers')).toBe('1 enum member');
    expect(pluralizeType(2, 'enumMembers')).toBe('2 enum members');
    expect(pluralizeType(1, 'namespaceMembers')).toBe('1 namespace member');
    expect(pluralizeType(2, 'namespaceMembers')).toBe('2 namespace members');
  });

  it('applies y -> ies for a trailing consonant+y', () => {
    expect(pluralizeType(1, 'dependencies')).toBe('1 dependency');
    expect(pluralizeType(2, 'dependencies')).toBe('2 dependencies');
    expect(pluralizeType(1, 'devDependencies')).toBe('1 dev dependency');
    expect(pluralizeType(2, 'devDependencies')).toBe('2 dev dependencies');
    expect(pluralizeType(1, 'optionalPeerDependencies')).toBe('1 peer dependency');
    expect(pluralizeType(2, 'optionalPeerDependencies')).toBe('2 peer dependencies');
  });

  it('handles a plain singular-noun type with no irregular ending', () => {
    expect(pluralizeType(1, 'binaries')).toBe('1 binary');
    expect(pluralizeType(2, 'binaries')).toBe('2 binaries');
  });

  it('reads naturally for unresolved/unlisted', () => {
    expect(pluralizeType(1, 'unresolved')).toBe('1 unresolved import');
    expect(pluralizeType(2, 'unresolved')).toBe('2 unresolved imports');
    expect(pluralizeType(1, 'unlisted')).toBe('1 unlisted dependency');
    expect(pluralizeType(2, 'unlisted')).toBe('2 unlisted dependencies');
  });

  it('covers every remaining IssueType with a sensible singular/plural pair', () => {
    const cases: [IssueType, string, string][] = [
      ['types', '1 type', '2 types'],
      ['nsExports', '1 namespace export', '2 namespace exports'],
      ['nsTypes', '1 namespace type', '2 namespace types'],
      ['duplicates', '1 duplicate export', '2 duplicate exports'],
      ['catalog', '1 catalog entry', '2 catalog entries'],
      ['cycles', '1 import cycle', '2 import cycles'],
    ];
    for (const [type, one, two] of cases) {
      expect(pluralizeType(1, type)).toBe(one);
      expect(pluralizeType(2, type)).toBe(two);
    }
  });

  it('treats 0 as plural', () => {
    expect(pluralizeType(0, 'files')).toBe('0 files');
  });
});
