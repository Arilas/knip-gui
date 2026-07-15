import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkspaceDirs } from '../../src/core/workspaces.js';

const monorepo = new URL('../fixtures/monorepo/', import.meta.url).pathname;
const single = new URL('../fixtures/single/', import.meta.url).pathname;

describe('getWorkspaceDirs', () => {
  it('expands npm-style workspaces globs, longest first, "." last', async () => {
    expect(await getWorkspaceDirs(monorepo)).toEqual(['packages/app', 'packages/lib', '.']);
  });

  it('returns ["."] for single-package projects', async () => {
    expect(await getWorkspaceDirs(single)).toEqual(['.']);
  });
});

describe('getWorkspaceDirs: glob expansion', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function pkg(rel: string, name = rel): void {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name }));
  }

  it('expands a `**` deep glob (packages/**)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/**'] }));
    pkg('packages/a');
    pkg('packages/group/b');
    // A nested node_modules must never be harvested as a workspace.
    pkg('packages/a/node_modules/dep');
    const dirs = await getWorkspaceDirs(dir);
    expect(dirs).toContain('packages/a');
    expect(dirs).toContain('packages/group/b');
    expect(dirs.some((d) => d.includes('node_modules'))).toBe(false);
    expect(dirs[dirs.length - 1]).toBe('.');
  });

  it('expands a mid-pattern wildcard (apps/*/plugin)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['apps/*/plugin'] }));
    pkg('apps/web/plugin');
    pkg('apps/api/plugin');
    mkdirSync(join(dir, 'apps/web/other'), { recursive: true }); // no package.json, not a plugin dir
    const dirs = await getWorkspaceDirs(dir);
    expect(dirs).toEqual(expect.arrayContaining(['apps/web/plugin', 'apps/api/plugin']));
    expect(dirs).not.toContain('apps/web/other');
  });

  it('applies negative (!) exclusions against the expanded set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*', '!packages/private'] }),
    );
    pkg('packages/pub');
    pkg('packages/private');
    const dirs = await getWorkspaceDirs(dir);
    expect(dirs).toContain('packages/pub');
    expect(dirs).not.toContain('packages/private');
  });

  it('reads pnpm-workspace.yaml only under the packages: key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  - some-catalog-entry\n',
    );
    pkg('packages/a');
    const dirs = await getWorkspaceDirs(dir);
    expect(dirs).toContain('packages/a');
    expect(dirs).not.toContain('some-catalog-entry');
  });
});
