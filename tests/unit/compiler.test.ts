import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileFixPlan, compileIgnorePlan, type FixSelection } from '../../src/fix/compiler.js';
import { PlanStore } from '../../src/fix/plan-store.js';
import { hashContent } from '../../src/fix/patch.js';
import { normalize } from '../../src/core/normalize.js';
import { FIX_MODES_BY_TYPE, type FixMode, type Issue, type IssueType } from '../../src/core/types.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-gui-compiler-'));
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

function makeIssue(
  id: string,
  type: IssueType,
  filePath: string,
  overrides: Partial<Issue> = {},
): Issue {
  const fixModes = overrides.fixModes ?? FIX_MODES_BY_TYPE[type];
  return {
    id,
    type,
    workspace: '.',
    filePath,
    fixable: fixModes.length > 0,
    fixModes,
    ...overrides,
  };
}

function itemFor(items: { issueId: string; ok: boolean; reason?: string }[], issueId: string) {
  const item = items.find((i) => i.issueId === issueId);
  if (!item) throw new Error(`no plan item for issueId '${issueId}'`);
  return item;
}

describe('compileFixPlan: source-transform chaining', () => {
  it('multiple exports stripped in one file produce a single patch with both changes applied', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      await seedFile(dir, 'src/two.ts', content);

      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/two.ts', { symbol: 'a', pos: content.indexOf('a') }),
        makeIssue('i2', 'exports', 'src/two.ts', { symbol: 'b', pos: content.indexOf('b') }),
      ];
      const selection: FixSelection = { issueIds: ['i1', 'i2'] };

      const plan = await compileFixPlan(dir, issues, selection);

      expect(plan.kind).toBe('fix');
      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true });
      expect(plan.patches).toHaveLength(1);
      const patch = plan.patches[0]!;
      expect(patch.filePath).toBe('src/two.ts');
      expect(patch.kind).toBe('modify');
      expect(patch.hashBefore).toBe(hashContent(content));
      expect(patch.contentAfter).toBe('const a = 1;\nconst b = 2;\n');

      expect(plan.diffs).toHaveLength(1);
      expect(plan.diffs[0]!.filePath).toBe('src/two.ts');
      expect(plan.diffs[0]!.diff).toContain('-export const a = 1;');
      expect(plan.diffs[0]!.diff).toContain('+const a = 1;');
    });
  });

  it('re-locates the second transform by symbol after the first shifts content (descending-pos order)', async () => {
    await withTmpDir(async (dir) => {
      // Two removable declarations of very different lengths so a naive
      // position-based second edit (without re-locating by symbol) would
      // land on the wrong text once the first edit has shifted the file.
      const content = 'export function first(): number {\n  return 1;\n}\nexport const second = 2;\n';
      await seedFile(dir, 'src/shift.ts', content);

      const issues: Issue[] = [
        makeIssue('first', 'exports', 'src/shift.ts', {
          symbol: 'first',
          pos: content.indexOf('first'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
        makeIssue('second', 'exports', 'src/shift.ts', {
          symbol: 'second',
          pos: content.indexOf('second'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
      ];
      const selection: FixSelection = {
        issueIds: ['first', 'second'],
        modeOverrides: { first: 'delete-declaration', second: 'delete-declaration' },
      };

      const plan = await compileFixPlan(dir, issues, selection);

      expect(itemFor(plan.items, 'first')).toEqual({ issueId: 'first', ok: true });
      expect(itemFor(plan.items, 'second')).toEqual({ issueId: 'second', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe('');
    });
  });

  it('applies a mode override (delete-declaration instead of the default strip-export)', async () => {
    await withTmpDir(async (dir) => {
      const content = '/**\n * Doc.\n */\nexport function foo() {\n  return 1;\n}\n';
      await seedFile(dir, 'src/over.ts', content);

      const issues: Issue[] = [
        makeIssue('i1', 'exports', 'src/over.ts', {
          symbol: 'foo',
          pos: content.indexOf('foo'),
          fixModes: ['strip-export', 'delete-declaration'],
        }),
      ];
      const selection: FixSelection = { issueIds: ['i1'], modeOverrides: { i1: 'delete-declaration' } };

      const plan = await compileFixPlan(dir, issues, selection);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe('');
    });
  });

  it('a transform failure mid-chain is recorded for that issue but the chain continues with the last good content', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      await seedFile(dir, 'src/partial.ts', content);

      const issues: Issue[] = [
        makeIssue('bad', 'exports', 'src/partial.ts', { symbol: 'nonexistent', pos: 999 }),
        makeIssue('good', 'exports', 'src/partial.ts', { symbol: 'b', pos: content.indexOf('b') }),
      ];
      const selection: FixSelection = { issueIds: ['bad', 'good'] };

      const plan = await compileFixPlan(dir, issues, selection);

      const badItem = itemFor(plan.items, 'bad');
      expect(badItem.ok).toBe(false);
      expect(badItem.reason).toBeTruthy();
      expect(itemFor(plan.items, 'good')).toEqual({ issueId: 'good', ok: true });

      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe('export const a = 1;\nconst b = 2;\n');
    });
  });

  it('removes an enum member via remove-member', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export enum Color {\n  Red,\n  Blue,\n}\n';
      await seedFile(dir, 'src/enum.ts', content);

      const issues: Issue[] = [
        makeIssue('i1', 'enumMembers', 'src/enum.ts', {
          symbol: 'Blue',
          parentSymbol: 'Color',
          pos: content.indexOf('Blue'),
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe('export enum Color {\n  Red,\n}\n');
    });
  });

  it('remove-duplicate targets only duplicateMembers[1..], never the canonical member', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const dupeSource = 42;\nexport const dupeAlias = dupeSource;\n';
      await seedFile(dir, 'src/dup.ts', content);

      const issues: Issue[] = [
        makeIssue('i1', 'duplicates', 'src/dup.ts', {
          symbol: 'dupeSource, dupeAlias',
          pos: content.indexOf('dupeSource'),
          duplicateMembers: [
            { symbol: 'dupeSource', pos: content.indexOf('dupeSource') },
            { symbol: 'dupeAlias', pos: content.indexOf('dupeAlias') },
          ],
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe('export const dupeSource = 42;\n');
    });
  });

  it('a duplicates issue with multiple aliases is ok:true only if every alias-removal succeeds', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const src = 1;\nexport const aliasOne = src;\n';
      await seedFile(dir, 'src/dup2.ts', content);

      const issues: Issue[] = [
        makeIssue('i1', 'duplicates', 'src/dup2.ts', {
          symbol: 'src, aliasOne, aliasTwo',
          duplicateMembers: [
            { symbol: 'src', pos: content.indexOf('src') },
            { symbol: 'aliasOne', pos: content.indexOf('aliasOne') },
            { symbol: 'aliasTwo', pos: 9999 }, // does not exist -> this member fails
          ],
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      const item = itemFor(plan.items, 'i1');
      expect(item.ok).toBe(false);
      expect(item.reason).toBeTruthy();
      // aliasOne's own removal still landed even though aliasTwo failed.
      expect(plan.patches[0]!.contentAfter).toBe('export const src = 1;\n');
    });
  });
});

describe('compileFixPlan: delete-file precedence', () => {
  it('delete-file wins over other queued edits to the same file, marking the superseded issue ok:true', async () => {
    await withTmpDir(async (dir) => {
      const content = 'export const a = 1;\n';
      await seedFile(dir, 'src/gone.ts', content);

      const issues: Issue[] = [
        makeIssue('exp', 'exports', 'src/gone.ts', { symbol: 'a', pos: content.indexOf('a') }),
        makeIssue('del', 'files', 'src/gone.ts'),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['exp', 'del'] });

      expect(itemFor(plan.items, 'exp')).toEqual({ issueId: 'exp', ok: true });
      expect(itemFor(plan.items, 'del')).toEqual({ issueId: 'del', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.kind).toBe('delete');
      expect(plan.patches[0]!.filePath).toBe('src/gone.ts');
      expect(plan.patches[0]!.contentAfter).toBeNull();
      expect(plan.patches[0]!.hashBefore).toBe(hashContent(content));
    });
  });

  it('mixed file+export selection across different files each produce their own patch', async () => {
    await withTmpDir(async (dir) => {
      const goneContent = 'export const z = 1;\n';
      const keepContent = 'export const a = 1;\n';
      await seedFile(dir, 'src/gone.ts', goneContent);
      await seedFile(dir, 'src/keep.ts', keepContent);

      const issues: Issue[] = [
        makeIssue('del', 'files', 'src/gone.ts'),
        makeIssue('exp', 'exports', 'src/keep.ts', { symbol: 'a', pos: keepContent.indexOf('a') }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['del', 'exp'] });

      expect(plan.patches).toHaveLength(2);
      const delPatch = plan.patches.find((p) => p.filePath === 'src/gone.ts')!;
      const expPatch = plan.patches.find((p) => p.filePath === 'src/keep.ts')!;
      expect(delPatch.kind).toBe('delete');
      expect(expPatch.kind).toBe('modify');
      expect(expPatch.contentAfter).toBe('const a = 1;\n');
    });
  });
});

describe('compileFixPlan: dependency removal', () => {
  it('removes a root-workspace dependency from package.json', async () => {
    await withTmpDir(async (dir) => {
      const pkg = '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}\n';
      await seedFile(dir, 'package.json', pkg);

      const issues: Issue[] = [
        makeIssue('i1', 'dependencies', 'package.json', { symbol: 'left-pad', workspace: '.' }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.filePath).toBe('package.json');
      expect(plan.patches[0]!.contentAfter).toBe('{\n  "name": "pkg",\n  "dependencies": {\n  }\n}\n');
    });
  });

  it('resolves a workspace-scoped dependency to that workspace\'s package.json', async () => {
    await withTmpDir(async (dir) => {
      const rootPkg = '{\n  "name": "root",\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}\n';
      const appPkg = '{\n  "name": "app",\n  "dependencies": {\n    "chalk": "5.0.0"\n  }\n}\n';
      await seedFile(dir, 'package.json', rootPkg);
      await seedFile(dir, 'packages/app/package.json', appPkg);

      const issues: Issue[] = [
        makeIssue('i1', 'dependencies', 'packages/app/package.json', {
          symbol: 'chalk',
          workspace: 'packages/app',
        }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.filePath).toBe('packages/app/package.json');
      expect(plan.patches[0]!.contentAfter).toBe('{\n  "name": "app",\n  "dependencies": {\n  }\n}\n');
      // root package.json is untouched
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(rootPkg);
    });
  });

  it('chains multiple dependency removals from the same package.json into one patch', async () => {
    await withTmpDir(async (dir) => {
      const pkg =
        '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "1.0.0",\n    "lodash": "4.0.0"\n  }\n}\n';
      await seedFile(dir, 'package.json', pkg);

      const issues: Issue[] = [
        makeIssue('i1', 'dependencies', 'package.json', { symbol: 'left-pad' }),
        makeIssue('i2', 'dependencies', 'package.json', { symbol: 'lodash' }),
      ];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1', 'i2'] });

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(itemFor(plan.items, 'i2')).toEqual({ issueId: 'i2', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.contentAfter).toBe('{\n  "name": "pkg",\n  "dependencies": {\n  }\n}\n');
    });
  });
});

describe('compileFixPlan: selection edge cases', () => {
  it('an unknown issueId produces an ok:false item and no patch', async () => {
    await withTmpDir(async (dir) => {
      const plan = await compileFixPlan(dir, [], { issueIds: ['does-not-exist'] });
      expect(itemFor(plan.items, 'does-not-exist')).toEqual({
        issueId: 'does-not-exist',
        ok: false,
        reason: 'unknown-issue',
      });
      expect(plan.patches).toHaveLength(0);
    });
  });

  it('an unfixable issue (empty fixModes) produces ok:false, reason:not-fixable', async () => {
    await withTmpDir(async (dir) => {
      const issues: Issue[] = [makeIssue('i1', 'unlisted', 'src/x.ts', { symbol: 'x', fixModes: [] })];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });
      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: false, reason: 'not-fixable' });
      expect(plan.patches).toHaveLength(0);
    });
  });

  it('an invalid mode override produces ok:false, reason:invalid-mode', async () => {
    await withTmpDir(async (dir) => {
      const issues: Issue[] = [
        makeIssue('i1', 'files', 'src/x.ts'), // fixModes: ['delete-file'] only
      ];
      const plan = await compileFixPlan(dir, issues, {
        issueIds: ['i1'],
        modeOverrides: { i1: 'strip-export' },
      });
      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: false, reason: 'invalid-mode' });
    });
  });

  it('a missing target file produces ok:false, reason:file-not-found', async () => {
    await withTmpDir(async (dir) => {
      const issues: Issue[] = [makeIssue('i1', 'files', 'src/missing.ts')];
      const plan = await compileFixPlan(dir, issues, { issueIds: ['i1'] });
      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: false, reason: 'file-not-found' });
    });
  });
});

describe('compileIgnorePlan', () => {
  it('mixes a config edit (dependency ignore) with a tag patch (export) in one plan', async () => {
    await withTmpDir(async (dir) => {
      await seedFile(dir, 'knip.json', '{\n  "entry": [\n    "src/index.ts"\n  ]\n}\n');
      const exportContent = 'export function keepMe() {\n  return 1;\n}\n';
      await seedFile(dir, 'src/pub.ts', exportContent);

      const issues: Issue[] = [
        makeIssue('dep', 'dependencies', 'package.json', { symbol: 'left-pad' }),
        makeIssue('exp', 'exports', 'src/pub.ts', { symbol: 'keepMe', pos: exportContent.indexOf('keepMe') }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['dep', 'exp']);

      expect(plan.kind).toBe('ignore');
      expect(itemFor(plan.items, 'dep')).toEqual({ issueId: 'dep', ok: true });
      expect(itemFor(plan.items, 'exp')).toEqual({ issueId: 'exp', ok: true });

      expect(plan.patches).toHaveLength(2);
      const configPatch = plan.patches.find((p) => p.filePath === 'knip.json')!;
      const tagPatch = plan.patches.find((p) => p.filePath === 'src/pub.ts')!;
      expect(configPatch.contentAfter).toBe(
        '{\n  "entry": [\n    "src/index.ts"\n  ],\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n',
      );
      expect(tagPatch.contentAfter).toBe(
        '/** @public */\nexport function keepMe() {\n  return 1;\n}\n',
      );
    });
  });

  it('files issue produces a workspace-scoped "ignore" config edit', async () => {
    await withTmpDir(async (dir) => {
      await seedFile(dir, 'knip.json', '{}\n');
      const issues: Issue[] = [makeIssue('i1', 'files', 'src/orphan.ts')];
      const plan = await compileIgnorePlan(dir, issues, ['i1']);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe('{\n  "ignore": [\n    "src/orphan.ts"\n  ]\n}\n');
    });
  });

  it('a binaries issue produces an ignoreBinaries config edit', async () => {
    await withTmpDir(async (dir) => {
      await seedFile(dir, 'knip.json', '{}\n');
      const issues: Issue[] = [makeIssue('i1', 'binaries', 'package.json', { symbol: 'some-cli' })];
      const plan = await compileIgnorePlan(dir, issues, ['i1']);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe('{\n  "ignoreBinaries": [\n    "some-cli"\n  ]\n}\n');
    });
  });

  it("an enumMembers issue tags the member's OWN line, not the parent enum", async () => {
    await withTmpDir(async (dir) => {
      const content = 'export enum Color {\n  Red,\n  Blue,\n}\n';
      await seedFile(dir, 'src/enum.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'enumMembers', 'src/enum.ts', {
          symbol: 'Blue',
          parentSymbol: 'Color',
          pos: content.indexOf('Blue'),
        }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['i1']);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe(
        'export enum Color {\n  Red,\n  /** @public */\n  Blue,\n}\n',
      );
    });
  });

  it('a namespaceMembers issue tags the member statement inside the namespace, not the parent', async () => {
    await withTmpDir(async (dir) => {
      const content =
        'export namespace Config {\n  export const usedFlag = true;\n  export const unusedFlag = false;\n}\n';
      await seedFile(dir, 'src/ns.ts', content);
      const issues: Issue[] = [
        makeIssue('i1', 'namespaceMembers', 'src/ns.ts', {
          symbol: 'unusedFlag',
          parentSymbol: 'Config',
          pos: content.indexOf('unusedFlag'),
        }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['i1']);

      expect(itemFor(plan.items, 'i1')).toEqual({ issueId: 'i1', ok: true });
      expect(plan.patches[0]!.contentAfter).toBe(
        'export namespace Config {\n  export const usedFlag = true;\n  /** @public */\n  export const unusedFlag = false;\n}\n',
      );
    });
  });

  it('v1-unignorable issue types (e.g. unlisted, cycles) fail with reason:not-ignorable', async () => {
    await withTmpDir(async (dir) => {
      const issues: Issue[] = [
        makeIssue('i1', 'unlisted', 'src/x.ts', { symbol: 'x' }),
        makeIssue('i2', 'cycles', 'src/y.ts'),
        makeIssue('i3', 'duplicates', 'src/z.ts', { symbol: 'a, b' }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['i1', 'i2', 'i3']);

      for (const id of ['i1', 'i2', 'i3']) {
        expect(itemFor(plan.items, id)).toEqual({ issueId: id, ok: false, reason: 'not-ignorable' });
      }
      expect(plan.patches).toHaveLength(0);
    });
  });

  it('config kind "code" fails config-dependent items with reason:code-config, independent of tag patches', async () => {
    await withTmpDir(async (dir) => {
      await seedFile(dir, 'knip.ts', 'export default {};\n');
      const exportContent = 'export function keepMe() {\n  return 1;\n}\n';
      await seedFile(dir, 'src/pub.ts', exportContent);

      const issues: Issue[] = [
        makeIssue('dep', 'dependencies', 'package.json', { symbol: 'left-pad' }),
        makeIssue('exp', 'exports', 'src/pub.ts', { symbol: 'keepMe', pos: exportContent.indexOf('keepMe') }),
      ];
      const plan = await compileIgnorePlan(dir, issues, ['dep', 'exp']);

      expect(itemFor(plan.items, 'dep')).toEqual({ issueId: 'dep', ok: false, reason: 'code-config' });
      expect(itemFor(plan.items, 'exp')).toEqual({ issueId: 'exp', ok: true });
      expect(plan.patches).toHaveLength(1);
      expect(plan.patches[0]!.filePath).toBe('src/pub.ts');
    });
  });

  it('no config at all fails config-dependent items with reason:no-config (v1 does not create one)', async () => {
    await withTmpDir(async (dir) => {
      await seedFile(dir, 'package.json', '{\n  "name": "pkg"\n}\n');
      const issues: Issue[] = [makeIssue('dep', 'dependencies', 'package.json', { symbol: 'left-pad' })];
      const plan = await compileIgnorePlan(dir, issues, ['dep']);

      expect(itemFor(plan.items, 'dep')).toEqual({ issueId: 'dep', ok: false, reason: 'no-config' });
      expect(plan.patches).toHaveLength(0);
    });
  });

  it('an unknown issueId produces an ok:false item', async () => {
    await withTmpDir(async (dir) => {
      const plan = await compileIgnorePlan(dir, [], ['nope']);
      expect(itemFor(plan.items, 'nope')).toEqual({ issueId: 'nope', ok: false, reason: 'unknown-issue' });
    });
  });
});

describe('PlanStore: single-use semantics', () => {
  it('take returns the plan once, then undefined on a second call', () => {
    const store = new PlanStore();
    const plan = {
      planId: 'abc123',
      kind: 'fix' as const,
      patches: [],
      diffs: [],
      items: [],
      createdAt: new Date().toISOString(),
    };
    store.put(plan);

    expect(store.take('abc123')).toBe(plan);
    expect(store.take('abc123')).toBeUndefined();
  });

  it('take on an id that was never put returns undefined', () => {
    const store = new PlanStore();
    expect(store.take('never-existed')).toBeUndefined();
  });

  it('two different plans can be stored and taken independently', () => {
    const store = new PlanStore();
    const planA = { planId: 'a', kind: 'fix' as const, patches: [], diffs: [], items: [], createdAt: '' };
    const planB = { planId: 'b', kind: 'ignore' as const, patches: [], diffs: [], items: [], createdAt: '' };
    store.put(planA);
    store.put(planB);

    expect(store.take('a')).toBe(planA);
    expect(store.take('b')).toBe(planB);
    expect(store.take('a')).toBeUndefined();
  });
});

describe('compileFixPlan: end-to-end against the real single fixture (no apply)', () => {
  it('compiles a plan from the captured knip report, using real issue ids', async () => {
    const fixtureDir = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
    const reportPath = fileURLToPath(new URL('../fixtures/single-report.json', import.meta.url));
    const raw = JSON.parse(readFileSync(reportPath, 'utf8'));
    const issues = normalize(raw, ['.']);

    // Pick a representative subset of real, captured issues: an unused
    // top-level export (src/used.ts#unusedHelper) and an unused dependency
    // (package.json#left-pad).
    const exportIssue = issues.find((i) => i.type === 'exports' && i.symbol === 'unusedHelper');
    const depIssue = issues.find((i) => i.type === 'dependencies' && i.symbol === 'left-pad');
    expect(exportIssue).toBeDefined();
    expect(depIssue).toBeDefined();

    const plan = await compileFixPlan(fixtureDir, issues, {
      issueIds: [exportIssue!.id, depIssue!.id],
    });

    expect(itemFor(plan.items, exportIssue!.id)).toEqual({ issueId: exportIssue!.id, ok: true });
    expect(itemFor(plan.items, depIssue!.id)).toEqual({ issueId: depIssue!.id, ok: true });

    const usedPatch = plan.patches.find((p) => p.filePath === 'src/used.ts');
    const pkgPatch = plan.patches.find((p) => p.filePath === 'package.json');
    expect(usedPatch).toBeDefined();
    expect(pkgPatch).toBeDefined();
    expect(usedPatch!.contentAfter).toContain('function unusedHelper');
    expect(usedPatch!.contentAfter).not.toContain('export function unusedHelper');
    expect(pkgPatch!.contentAfter).not.toContain('left-pad');

    // Nothing was written to disk — this is a plan only.
    expect(existsSync(join(fixtureDir, 'src', 'used.ts'))).toBe(true);
    expect(readFileSync(join(fixtureDir, 'src', 'used.ts'), 'utf8')).toContain('export function unusedHelper');
  });
});
