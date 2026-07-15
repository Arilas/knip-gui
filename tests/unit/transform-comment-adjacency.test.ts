import { describe, expect, it } from 'vitest';
import { deleteDeclaration } from '../../src/fix/transforms/delete-declaration.js';
import { removeMember } from '../../src/fix/transforms/remove-member.js';
import { insertPublicTag } from '../../src/ignore/public-tag.js';
import type { TransformResult } from '../../src/fix/transforms/source.js';

function expectOk(result: TransformResult): string {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false reason=${result.reason}`);
  return result.newContent;
}

// Regression suite for the "comment directly above me might actually be the
// PREVIOUS statement's trailing comment" class of bug: adjacency was decided by
// whitespace-between-comment-and-node only, ignoring whether the comment starts
// its own line. A same-line trailing comment on the preceding statement sits
// exactly one newline above the next node and was wrongly swept into its edit.
describe('comment adjacency: a preceding statement trailing comment is never touched', () => {
  it('deleteDeclaration keeps a previous line trailing comment', () => {
    const content = 'const keep = 1; // important note\nexport const dead = 2;\n';
    // Only `dead`'s own declaration line should go; the note belongs to `keep`.
    expect(expectOk(deleteDeclaration({ filePath: 'a.ts', content, symbol: 'dead' }))).toBe(
      'const keep = 1; // important note\n',
    );
  });

  it('deleteDeclaration still sweeps a genuine own-line leading comment', () => {
    const content = 'const keep = 1;\n// leads dead\nexport const dead = 2;\n';
    expect(expectOk(deleteDeclaration({ filePath: 'a.ts', content, symbol: 'dead' }))).toBe(
      'const keep = 1;\n',
    );
  });

  it('insertPublicTag does not merge @public into a previous line trailing JSDoc', () => {
    const content = 'const keep = 1; /** keep doc */\nexport const pub = 2;\n';
    const out = expectOk(insertPublicTag({ filePath: 'a.ts', content, symbol: 'pub' }));
    // `keep`'s doc must be untouched; a fresh /** @public */ goes above `pub`.
    expect(out).toContain('const keep = 1; /** keep doc */\n');
    expect(out).toContain('/** @public */\nexport const pub = 2;');
  });

  it('removeEnumMember takes the removed member own-line leading JSDoc with it', () => {
    const content = 'enum E {\n  /** doc for A */\n  A = 1,\n  B = 2,\n}\n';
    const out = expectOk(removeMember({ filePath: 'a.ts', content, symbol: 'A', parentSymbol: 'E' }));
    // The doc belonged to A and must go; B keeps its place with no orphaned doc.
    expect(out).not.toContain('doc for A');
    expect(out).toBe('enum E {\n  B = 2,\n}\n');
  });
});
