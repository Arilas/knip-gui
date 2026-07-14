import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDependency } from '../../src/fix/transforms/package-json.js';
import {
  addIgnores,
  findKnipConfig,
  listIgnores,
  removeIgnores,
  type IgnoreEdit,
  type IgnoreEntry,
} from '../../src/ignore/config-writer.js';
import type { TransformResult } from '../../src/fix/transforms/source.js';

function expectOk(result: TransformResult): string {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false reason=${result.reason}`);
  return result.newContent;
}

describe('removeDependency', () => {
  it('removes a middle dependency, preserving indentation and surrounding content byte-exactly', () => {
    const content =
      '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "^1.0.0",\n    "lodash": "^4.17.21",\n    "chalk": "^5.0.0"\n  }\n}\n';
    const result = removeDependency(content, 'lodash', 'dependencies');
    expect(expectOk(result)).toBe(
      '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "^1.0.0",\n    "chalk": "^5.0.0"\n  }\n}\n',
    );
  });

  it('removes the only dependency in a section, leaving an empty object', () => {
    const content = '{\n  "name": "pkg",\n  "devDependencies": {\n    "typescript": "^5.0.0"\n  }\n}\n';
    const result = removeDependency(content, 'typescript', 'devDependencies');
    expect(expectOk(result)).toBe('{\n  "name": "pkg",\n  "devDependencies": {\n  }\n}\n');
  });

  it('removes the last dependency, dropping the preceding comma', () => {
    const content =
      '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "^1.0.0",\n    "lodash": "^4.17.21"\n  }\n}\n';
    const result = removeDependency(content, 'lodash', 'dependencies');
    expect(expectOk(result)).toBe(
      '{\n  "name": "pkg",\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n',
    );
  });

  it('preserves tab indentation and CRLF-free/CRLF EOL style', () => {
    const content = '{\r\n\t"dependencies": {\r\n\t\t"left-pad": "^1.0.0",\r\n\t\t"lodash": "^4.17.21"\r\n\t}\r\n}\r\n';
    const result = removeDependency(content, 'left-pad', 'dependencies');
    expect(expectOk(result)).toBe('{\r\n\t"dependencies": {\r\n\t\t"lodash": "^4.17.21"\r\n\t}\r\n}\r\n');
  });

  it('returns {ok:false, reason:"not-found"} when the dependency key is absent', () => {
    const content = '{\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n';
    const result = removeDependency(content, 'does-not-exist', 'dependencies');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns {ok:false, reason:"not-found"} when the section itself is absent', () => {
    const content = '{\n  "name": "pkg"\n}\n';
    const result = removeDependency(content, 'left-pad', 'devDependencies');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  // Ground truth (see task-5-report.md): knip's DependencyDeputy treats an
  // "optional peer dependency" issue as a `peerDependencies` entry whose name also
  // appears in `peerDependenciesMeta` with `optional: true` — there is no separate
  // `optionalPeerDependencies` key in package.json. Removing one must drop BOTH.
  describe('optionalPeerDependencies (maps to peerDependencies + peerDependenciesMeta)', () => {
    const content =
      '{\n  "name": "pkg",\n  "peerDependencies": {\n    "react": "^18.0.0",\n    "lodash-es": "^4.0.0"\n  },\n  "peerDependenciesMeta": {\n    "lodash-es": {\n      "optional": true\n    }\n  }\n}\n';

    it('removes both the peerDependencies entry and the peerDependenciesMeta entry', () => {
      const result = removeDependency(content, 'lodash-es', 'optionalPeerDependencies');
      expect(expectOk(result)).toBe(
        '{\n  "name": "pkg",\n  "peerDependencies": {\n    "react": "^18.0.0"\n  },\n  "peerDependenciesMeta": {\n  }\n}\n',
      );
    });

    it('still succeeds when there is no peerDependenciesMeta entry to clean up', () => {
      const noMeta = '{\n  "name": "pkg",\n  "peerDependencies": {\n    "react": "^18.0.0",\n    "chalk": "^5.0.0"\n  }\n}\n';
      const result = removeDependency(noMeta, 'chalk', 'optionalPeerDependencies');
      expect(expectOk(result)).toBe(
        '{\n  "name": "pkg",\n  "peerDependencies": {\n    "react": "^18.0.0"\n  }\n}\n',
      );
    });

    it('not-found when the name is absent from peerDependencies', () => {
      const result = removeDependency(content, 'vue', 'optionalPeerDependencies');
      expect(result).toEqual({ ok: false, reason: 'not-found' });
    });
  });
});

describe('addIgnores', () => {
  it('creates the array when the ignore key is missing', () => {
    const content = '{\n  "entry": [\n    "src/index.ts"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe(
      '{\n  "entry": [\n    "src/index.ts"\n  ],\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n',
    );
  });

  it('appends to an existing array', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'chalk' }];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe('{\n  "ignoreDependencies": [\n    "left-pad",\n    "chalk"\n  ]\n}\n');
  });

  it('dedupes: a value already present is a no-op (byte-exact passthrough)', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe(content);
  });

  it('dedupes within a single batch of edits targeting the same array', () => {
    const content = '{\n  "ignore": [\n    "a"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [
      { kind: 'ignore', value: 'b' },
      { kind: 'ignore', value: 'b' },
    ];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe('{\n  "ignore": [\n    "a",\n    "b"\n  ]\n}\n');
  });

  it('preserves comments in a knip.jsonc file untouched by the edit', () => {
    const content =
      '{\n  // entry files\n  "entry": ["src/index.ts"],\n  "ignore": ["**/fixtures/**"] // keep fixtures out\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = addIgnores(content, 'knip.jsonc', edits);
    expect(expectOk(result)).toBe(
      '{\n  // entry files\n  "entry": ["src/index.ts"],\n  "ignore": [\n    "**/fixtures/**"\n  ],\n  "ignoreDependencies": [\n    "left-pad"\n  ] // keep fixtures out\n}\n',
    );
  });

  it('scopes a workspace-set edit under workspaces[<ws>], creating it if absent', () => {
    const content = '{\n  "entry": [\n    "src/index.ts"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: 'packages/app' }];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe(
      '{\n  "entry": [\n    "src/index.ts"\n  ],\n  "workspaces": {\n    "packages/app": {\n      "ignoreDependencies": [\n        "left-pad"\n      ]\n    }\n  }\n}\n',
    );
  });

  it('treats workspace "." as the root, not a workspaces[.] entry', () => {
    const content = '{\n  "entry": [\n    "src/index.ts"\n  ]\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }];
    const result = addIgnores(content, 'knip.json', edits);
    expect(expectOk(result)).toBe(
      '{\n  "entry": [\n    "src/index.ts"\n  ],\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n',
    );
  });

  it('package.json variant nests edits under the "knip" property', () => {
    const content = '{\n  "name": "pkg",\n  "knip": {\n    "entry": [\n      "src/index.ts"\n    ]\n  }\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = addIgnores(content, 'package.json', edits);
    expect(expectOk(result)).toBe(
      '{\n  "name": "pkg",\n  "knip": {\n    "entry": [\n      "src/index.ts"\n    ],\n    "ignoreDependencies": [\n      "left-pad"\n    ]\n  }\n}\n',
    );
  });

  it('package.json variant + workspace scoping nests under knip.workspaces[<ws>]', () => {
    const content = '{\n  "name": "pkg",\n  "knip": {}\n}\n';
    const edits: IgnoreEdit[] = [{ kind: 'ignore', value: '**/fixtures/**', workspace: 'packages/app' }];
    const result = addIgnores(content, 'package.json', edits);
    expect(expectOk(result)).toBe(
      '{\n  "name": "pkg",\n  "knip": {\n    "workspaces": {\n      "packages/app": {\n        "ignore": [\n          "**/fixtures/**"\n        ]\n      }\n    }\n  }\n}\n',
    );
  });
});

describe('findKnipConfig', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns {kind:"none"} when nothing is present', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"pkg"}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'none' });
  });

  it('finds knip.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    const path = join(dir, 'knip.json');
    writeFileSync(path, '{}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'knip.json', path });
  });

  it('finds the dotfile variant .knip.json under kind "knip.json"', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    const path = join(dir, '.knip.json');
    writeFileSync(path, '{}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'knip.json', path });
  });

  it('finds knip.jsonc when there is no knip.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    const path = join(dir, 'knip.jsonc');
    writeFileSync(path, '{\n  // comment\n}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'knip.jsonc', path });
  });

  it('finds package.json#knip when there is no dedicated config file', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    const path = join(dir, 'package.json');
    writeFileSync(path, '{\n  "name": "pkg",\n  "knip": {}\n}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'package.json', path });
  });

  it('returns {kind:"none"} for a package.json with no "knip" property and no config file', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "pkg"\n}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'none' });
  });

  it('prefers package.json#knip over a co-existing knip.ts (writable JSON beats code)', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "pkg",\n  "knip": {}\n}\n');
    writeFileSync(join(dir, 'knip.ts'), 'export default {};\n');
    // knip.json/knip.jsonc/package.json#knip all take precedence over a code config
    // by this writer's design (see config-writer.ts) — code is last before "none".
    expect(findKnipConfig(dir)).toEqual({ kind: 'package.json', path: join(dir, 'package.json') });
  });

  it('reports kind "code" for a bare knip.ts with no writable alternative', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "pkg"\n}\n');
    const path = join(dir, 'knip.ts');
    writeFileSync(path, 'export default {};\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'code', path });
  });

  it('reports kind "code" for knip.config.js', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "pkg"\n}\n');
    const path = join(dir, 'knip.config.js');
    writeFileSync(path, 'module.exports = {};\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'code', path });
  });

  it('prefers knip.json over knip.jsonc when both exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-config-'));
    const jsonPath = join(dir, 'knip.json');
    writeFileSync(jsonPath, '{}\n');
    writeFileSync(join(dir, 'knip.jsonc'), '{}\n');
    expect(findKnipConfig(dir)).toEqual({ kind: 'knip.json', path: jsonPath });
  });
});

describe('removeIgnores', () => {
  it('removes the only value, dropping the key entirely (not an empty array)', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = removeIgnores(content, 'knip.json', entries);
    expect(expectOk(result)).toBe('{\n}\n');
  });

  it('removes one of several values, leaving the rest', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad",\n    "chalk"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = removeIgnores(content, 'knip.json', entries);
    expect(expectOk(result)).toBe('{\n  "ignoreDependencies": [\n    "chalk"\n  ]\n}\n');
  });

  it('removes a workspace-scoped value, dropping only that array', () => {
    const content =
      '{\n  "workspaces": {\n    "packages/app": {\n      "ignore": [\n        "src/orphan.ts"\n      ]\n    }\n  }\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignore', value: 'src/orphan.ts', workspace: 'packages/app' }];
    const result = removeIgnores(content, 'knip.json', entries);
    expect(expectOk(result)).toBe('{\n  "workspaces": {\n    "packages/app": {\n    }\n  }\n}\n');
  });

  it('treats workspace "." as root when removing', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }];
    const result = removeIgnores(content, 'knip.json', entries);
    expect(expectOk(result)).toBe('{\n}\n');
  });

  it('returns {ok:false, reason:"not-found"} when the value is absent from the array', () => {
    const content = '{\n  "ignoreDependencies": [\n    "left-pad"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'does-not-exist' }];
    expect(removeIgnores(content, 'knip.json', entries)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns {ok:false, reason:"not-found"} when the array itself is absent', () => {
    const content = '{\n  "entry": [\n    "src/index.ts"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignore', value: 'src/orphan.ts' }];
    expect(removeIgnores(content, 'knip.json', entries)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('preserves comments in a knip.jsonc file untouched by the edit', () => {
    const content =
      '{\n  // entry files\n  "entry": ["src/index.ts"],\n  "ignoreDependencies": ["left-pad", "chalk"] // keep\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'chalk' }];
    const result = removeIgnores(content, 'knip.jsonc', entries);
    expect(expectOk(result)).toBe(
      '{\n  // entry files\n  "entry": ["src/index.ts"],\n  "ignoreDependencies": [\n    "left-pad"\n  ] // keep\n}\n',
    );
  });

  it('package.json variant removes from under the "knip" property', () => {
    const content =
      '{\n  "name": "pkg",\n  "knip": {\n    "ignoreDependencies": [\n      "left-pad"\n    ]\n  }\n}\n';
    const entries: IgnoreEntry[] = [{ kind: 'ignoreDependencies', value: 'left-pad' }];
    const result = removeIgnores(content, 'package.json', entries);
    expect(expectOk(result)).toBe('{\n  "name": "pkg",\n  "knip": {\n  }\n}\n');
  });

  it('processes entries in order, threading content — removing two values from the same array', () => {
    const content = '{\n  "ignore": [\n    "a",\n    "b",\n    "c"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [
      { kind: 'ignore', value: 'a' },
      { kind: 'ignore', value: 'c' },
    ];
    const result = removeIgnores(content, 'knip.json', entries);
    expect(expectOk(result)).toBe('{\n  "ignore": [\n    "b"\n  ]\n}\n');
  });

  it('fails atomically: a not-found entry later in the batch fails the whole call', () => {
    const content = '{\n  "ignore": [\n    "a",\n    "b"\n  ]\n}\n';
    const entries: IgnoreEntry[] = [
      { kind: 'ignore', value: 'a' },
      { kind: 'ignore', value: 'does-not-exist' },
    ];
    expect(removeIgnores(content, 'knip.json', entries)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('listIgnores', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty entries and kind "none" when there is no config at all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"pkg"}\n');
    expect(await listIgnores(dir)).toEqual({ entries: [], configKind: 'none' });
  });

  it('returns empty entries and kind "code" (with path) for a code config', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"pkg"}\n');
    writeFileSync(join(dir, 'knip.ts'), 'export default {};\n');
    expect(await listIgnores(dir)).toEqual({ entries: [], configKind: 'code', configPath: 'knip.ts' });
  });

  it('lists root-level entries across all three ignore kinds, tagged workspace "."', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(
      join(dir, 'knip.json'),
      JSON.stringify({
        ignore: ['src/orphan.ts'],
        ignoreDependencies: ['left-pad', 'chalk'],
        ignoreBinaries: ['tsc'],
      }),
    );
    const result = await listIgnores(dir);
    expect(result.configKind).toBe('knip.json');
    expect(result.configPath).toBe('knip.json');
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { kind: 'ignore', value: 'src/orphan.ts', workspace: '.' },
        { kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' },
        { kind: 'ignoreDependencies', value: 'chalk', workspace: '.' },
        { kind: 'ignoreBinaries', value: 'tsc', workspace: '.' },
      ]),
    );
    expect(result.entries).toHaveLength(4);
  });

  it('lists workspace-scoped entries tagged with their own workspace name', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(
      join(dir, 'knip.json'),
      JSON.stringify({
        ignoreDependencies: ['left-pad'],
        workspaces: {
          'packages/app': { ignore: ['src/orphan.ts'] },
          'packages/lib': { ignoreDependencies: ['chalk'] },
        },
      }),
    );
    const result = await listIgnores(dir);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' },
        { kind: 'ignore', value: 'src/orphan.ts', workspace: 'packages/app' },
        { kind: 'ignoreDependencies', value: 'chalk', workspace: 'packages/lib' },
      ]),
    );
    expect(result.entries).toHaveLength(3);
  });

  it('reads package.json#knip, including its nested workspaces', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        knip: {
          ignoreDependencies: ['left-pad'],
          workspaces: { 'packages/app': { ignore: ['src/orphan.ts'] } },
        },
      }),
    );
    const result = await listIgnores(dir);
    expect(result.configKind).toBe('package.json');
    expect(result.configPath).toBe('package.json');
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' },
        { kind: 'ignore', value: 'src/orphan.ts', workspace: 'packages/app' },
      ]),
    );
    expect(result.entries).toHaveLength(2);
  });

  it('preserves jsonc comments — parses (rather than edits) a knip.jsonc file fine', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    writeFileSync(
      join(dir, 'knip.jsonc'),
      '{\n  // deps we know about\n  "ignoreDependencies": ["left-pad"]\n}\n',
    );
    const result = await listIgnores(dir);
    expect(result.configKind).toBe('knip.jsonc');
    expect(result.entries).toEqual([{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }]);
  });

  it('nested workspace directories do not confuse project-relative configPath', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-list-'));
    await mkdir(join(dir, 'packages', 'app'), { recursive: true });
    writeFileSync(join(dir, 'knip.json'), JSON.stringify({ ignoreDependencies: ['left-pad'] }));
    const result = await listIgnores(dir);
    expect(result.configPath).toBe('knip.json');
  });
});
