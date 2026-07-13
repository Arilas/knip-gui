import { describe, expect, it } from 'vitest';
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
