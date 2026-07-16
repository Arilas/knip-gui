import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileFixPlan, type FixSelection } from '../../src/fix/compiler.js';
import { compileIgnorePlan } from '../../src/ignore/compile.js';
import { FIX_MODES_BY_TYPE, type Issue, type IssueType } from '../../src/core/types.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-gui-compiler-batch-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function makeIssue(id: string, type: IssueType, filePath: string, overrides: Partial<Issue> = {}): Issue {
  const fixModes = overrides.fixModes ?? FIX_MODES_BY_TYPE[type];
  return { id, type, workspace: '.', filePath, fixable: fixModes.length > 0, fixModes, ...overrides };
}

function itemFor(items: { issueId: string; ok: boolean; reason?: string }[], issueId: string) {
  const item = items.find((i) => i.issueId === issueId);
  if (!item) throw new Error(`no plan item for issueId '${issueId}'`);
  return item;
}

describe('compileFixPlan: batch compilation per file', () => {
  it('cross-mode overlap fails the later mode op with the conflict reason', async () => {
    await withTmpDir(async (dir) => {
      const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
      await seedFile(dir, 'src/x.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/x.ts', {
          symbol: 'a',
          pos: content.indexOf('a, b'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
        makeIssue('i2', 'exports', 'src/x.ts', {
          symbol: 'b',
          pos: content.indexOf('b };'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
      ];
      const selection: FixSelection = { issueIds: ['i1', 'i2'], modeOverrides: { i2: 'delete-declaration' } };
      const plan = await compileFixPlan(dir, issues, selection);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/x.ts' });
      expect(itemFor(plan.items, 'i2')).toEqual({
        issueId: 'i2',
        ok: false,
        reason: 'conflicts with another selected fix in the same statement',
        filePath: 'src/x.ts',
      });
      // The conflicting op's OTHER edit (deleting `function b`) is dropped too.
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe(
        'function a() { return 1; }\nfunction b() { return 2; }\nexport { b };\n',
      );
    });
  });

  it('emptying an export list removes the whole statement', async () => {
    await withTmpDir(async (dir) => {
      const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
      await seedFile(dir, 'src/x.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/x.ts', { symbol: 'a', pos: content.indexOf('a, b') }),
        makeIssue('i2', 'exports', 'src/x.ts', { symbol: 'b', pos: content.indexOf('b };') }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1', 'i2'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/x.ts' });
      expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/x.ts' });
      expect(plan.patches[0]!.contentAfter).toBe(
        'function a() { return 1; }\nfunction b() { return 2; }\n\n',
      );
    });
  });

  it('removes multiple members of one enum in one patch', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export enum Color {\n  Red,\n  Blue,\n  Green,\n}\n';
      await seedFile(dir, 'src/enum.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'enumMembers', 'src/enum.ts', {
          symbol: 'Blue',
          parentSymbol: 'Color',
          pos: content.indexOf('Blue'),
        }),
        makeIssue('i2', 'enumMembers', 'src/enum.ts', {
          symbol: 'Green',
          parentSymbol: 'Color',
          pos: content.indexOf('Green'),
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1', 'i2'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/enum.ts' });
      expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/enum.ts' });
      expect(plan.patches[0]!.contentAfter).toBe('export enum Color {\n  Red,\n}\n');
    });
  });

  it('a duplicates issue with two aliases compiles to one ok item and one patch', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const src = 1;\nexport const alias1 = src;\nexport const alias2 = src;\n';
      await seedFile(dir, 'src/dup.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'duplicates', 'src/dup.ts', {
          symbol: 'src, alias1, alias2',
          duplicateMembers: [
            { symbol: 'src', pos: content.indexOf('src = 1') },
            { symbol: 'alias1', pos: content.indexOf('alias1') },
            { symbol: 'alias2', pos: content.indexOf('alias2') },
          ],
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/dup.ts' });
      expect(plan.patches[0]!.contentAfter).toBe('export const src = 1;\n');
    });
  });

  it('mixed modes on one file cooperate when they do not overlap', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      await seedFile(dir, 'src/mix.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/mix.ts', {
          symbol: 'a',
          pos: content.indexOf('a = 1'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
        makeIssue('i2', 'exports', 'src/mix.ts', {
          symbol: 'b',
          pos: content.indexOf('b = 2'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
      ];
      const plan = await compileFixPlan(dir, issues, {
        issueIds: ['i1', 'i2'],
        modeOverrides: { i2: 'delete-declaration' },
      });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/mix.ts' });
      expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true, filePath: 'src/mix.ts' });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe('const a = 1;\n');
    });
  });

  it('multi-owner conflict cascade: a shared whole-statement edit fails both owners and drops their localSpan sweeps', async () => {
    await withTmpDir(async (dir) => {
      const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
      await seedFile(dir, 'src/cascade.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/cascade.ts', {
          symbol: 'a',
          pos: content.indexOf('a, b'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
        makeIssue('i2', 'exports', 'src/cascade.ts', {
          symbol: 'a',
          pos: content.indexOf('a, b'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
        makeIssue('i3', 'exports', 'src/cascade.ts', {
          symbol: 'b',
          pos: content.indexOf('b };'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
      ];
      const selection: FixSelection = {
        issueIds: ['i1', 'i2', 'i3'],
        modeOverrides: { i1: 'strip-export', i2: 'delete-declaration', i3: 'delete-declaration' },
      };
      const plan = await compileFixPlan(dir, issues, selection);

      // strip-export runs first (fixed mode order) and wins: `a` comes out of
      // the export list. delete-declaration's list group (i2 on `a`, i3 on `b`)
      // then empties -> ONE whole-statement edit owned by BOTH i2 and i3, which
      // overlaps i1's already-accepted edit. The conflict cascades to a fixpoint:
      // both owners fail, and their OTHER edits (the localSpan sweeps deleting
      // `function a` and `function b`) are dropped too, so both declarations
      // survive.
      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true, filePath: 'src/cascade.ts' });
      expect(itemFor(plan.items, 'i2')).toEqual({
        issueId: 'i2',
        ok: false,
        reason: 'conflicts with another selected fix in the same statement',
        filePath: 'src/cascade.ts',
      });
      expect(itemFor(plan.items, 'i3')).toEqual({
        issueId: 'i3',
        ok: false,
        reason: 'conflicts with another selected fix in the same statement',
        filePath: 'src/cascade.ts',
      });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe(
        'function a() { return 1; }\nfunction b() { return 2; }\nexport { b };\n',
      );
    });
  });
});

describe('compileIgnorePlan: batch tag insertion per file', () => {
  it('tags a member and a top-level export in one file with one patch (one parse)', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export enum Color {\n  Red,\n  Blue,\n}\nexport const flag = 1;\n';
      await seedFile(dir, 'src/tags.ts', content);
      const issues: Issue[] = [
        makeIssue('m', 'enumMembers', 'src/tags.ts', {
          symbol: 'Blue',
          parentSymbol: 'Color',
          pos: content.indexOf('Blue'),
        }),
        makeIssue('t', 'exports', 'src/tags.ts', { symbol: 'flag', pos: content.indexOf('flag') }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['m', 't']);

      expect(itemFor(plan.items, 'm')).toEqual({ issueId: 'm', ok: true, filePath: 'src/tags.ts' });
      expect(itemFor(plan.items, 't')).toEqual({ issueId: 't', ok: true, filePath: 'src/tags.ts' });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe(
        'export enum Color {\n  Red,\n  /** @public */\n  Blue,\n}\n/** @public */\nexport const flag = 1;\n',
      );
    });
  });
});
