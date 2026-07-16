import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearWorkspaceDirsCache, getWorkspaceDirs } from '../../src/core/workspaces.js';

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

describe('getWorkspaceDirs: mtime-keyed cache (#37)', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function pkg(rel: string): void {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel }));
  }

  it('reuses the cached walk while both manifests are unchanged (documented staleness)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
    clearWorkspaceDirsCache();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    pkg('packages/a');
    expect(await getWorkspaceDirs(dir)).toContain('packages/a');

    // New dir matching the glob, manifests untouched → cache hit, stale by
    // design (the accepted contract; see the cache comment in workspaces.ts).
    pkg('packages/b');
    expect(await getWorkspaceDirs(dir)).not.toContain('packages/b');
  });

  it('re-walks when the root package.json mtime moves', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
    clearWorkspaceDirsCache();
    const manifest = join(dir, 'package.json');
    writeFileSync(manifest, JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    pkg('packages/a');
    await getWorkspaceDirs(dir);

    pkg('packages/b');
    // Bump mtime explicitly — same-content rewrites within one timestamp
    // granule would otherwise make this flaky.
    const later = new Date(Date.now() + 5_000);
    utimesSync(manifest, later, later);
    expect(await getWorkspaceDirs(dir)).toContain('packages/b');
  });

  it('clearWorkspaceDirsCache forces a re-walk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
    clearWorkspaceDirsCache();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    pkg('packages/a');
    await getWorkspaceDirs(dir);
    pkg('packages/b');
    clearWorkspaceDirsCache();
    expect(await getWorkspaceDirs(dir)).toContain('packages/b');
  });

  it('returns a fresh array per call (cache hits are copies, not shared references)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
    clearWorkspaceDirsCache();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    pkg('packages/a');
    const first = await getWorkspaceDirs(dir);
    first.length = 0; // a consumer mutating its copy...
    expect(await getWorkspaceDirs(dir)).toContain('packages/a'); // ...must not poison the cache
  });
});

describe('getWorkspaceDirs: build-output dirs and `**` (#37)', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function pkg(rel: string): void {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel }));
  }

  it('`packages/**` does not descend into build-output dirs (dist, .turbo, coverage, ...)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-skip-'));
    clearWorkspaceDirsCache();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/**'] }));
    pkg('packages/a');
    pkg('packages/a/dist/bundled-fixture'); // stray package.json in build output
    pkg('packages/.turbo/cached');
    const dirs = await getWorkspaceDirs(dir);
    expect(dirs).toContain('packages/a');
    expect(dirs.some((d) => d.includes('dist') || d.includes('.turbo'))).toBe(false);
  });

  it('an explicit single-`*` glob still matches a directory literally named dist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-skip-'));
    clearWorkspaceDirsCache();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    pkg('packages/dist'); // unusual but explicitly requested by the glob
    expect(await getWorkspaceDirs(dir)).toContain('packages/dist');
  });
});
