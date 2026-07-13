import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gitCommitPaths, gitCreateBranch, GitError, gitStatus } from '../../src/git/git.js';

const execFileAsync = promisify(execFile);

// Every temp repo lives under the OS tmpdir (NOT inside this project's own
// working tree, which is itself a git repo) so tests never risk resolving
// git commands against knip-gui's real .git.
const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

// Local-only identity: never touches host/global git config.
async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('gitStatus', () => {
  it('returns isRepo:false for a plain directory that is not a repo at all', async () => {
    const dir = await makeTmpDir('knip-gui-git-plain-');
    const status = await gitStatus(dir);
    expect(status).toEqual({ isRepo: false });
  });

  it('returns isRepo:false (not true) for a non-repo dir nested INSIDE a repo (walk-up guard)', async () => {
    // git itself would happily walk up from `inner/` and find the parent's
    // .git — a naive `git rev-parse --is-inside-work-tree` check would report
    // isRepo:true here even though `inner/` is not itself a repo root. We
    // guard against that by comparing --show-toplevel to the queried dir.
    const repoDir = await makeTmpDir('knip-gui-git-outer-');
    await initRepo(repoDir);
    await writeFile(join(repoDir, 'root.txt'), 'root', 'utf8');
    await commitAll(repoDir, 'root commit');

    const innerDir = join(repoDir, 'inner');
    await mkdir(innerDir);

    const status = await gitStatus(innerDir);
    expect(status).toEqual({ isRepo: false });
  });

  it('detects a clean repo and reports the current branch', async () => {
    const dir = await makeTmpDir('knip-gui-git-clean-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    const status = await gitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.dirty).toBe(false);
    expect(status.dirtyFiles).toEqual([]);
  });

  it('detects a dirty repo and lists the dirty files', async () => {
    const dir = await makeTmpDir('knip-gui-git-dirty-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await writeFile(join(dir, 'b.txt'), 'world', 'utf8');
    await commitAll(dir, 'initial');

    await writeFile(join(dir, 'a.txt'), 'changed', 'utf8');
    await writeFile(join(dir, 'c.txt'), 'new file', 'utf8');

    const status = await gitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles).toEqual(expect.arrayContaining(['a.txt', 'c.txt']));
    expect(status.dirtyFiles).toHaveLength(2);
  });

  it('reports filenames with spaces verbatim (no C-quoting) and they round-trip into gitCommitPaths', async () => {
    const dir = await makeTmpDir('knip-gui-git-spaces-');
    await initRepo(dir);
    await writeFile(join(dir, 'base.txt'), 'base', 'utf8');
    await commitAll(dir, 'initial');

    await writeFile(join(dir, 'file with spaces.txt'), 'spaced out', 'utf8');

    const status = await gitStatus(dir);
    // Porcelain v1 without -z wraps this in literal quotes: "file with spaces.txt".
    // That quoted string fed back into `git add --` fails with exit 128, so the
    // status output must carry the raw path.
    expect(status.dirtyFiles).toEqual(['file with spaces.txt']);

    const result = await gitCommitPaths(dir, status.dirtyFiles!, 'commit spaced file');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await gitStatus(dir);
    expect(after.dirty).toBe(false);
  });

  it('reports non-ASCII filenames verbatim (no octal escaping) and they round-trip into gitCommitPaths', async () => {
    const dir = await makeTmpDir('knip-gui-git-utf8-');
    await initRepo(dir);
    await writeFile(join(dir, 'base.txt'), 'base', 'utf8');
    await commitAll(dir, 'initial');

    await writeFile(join(dir, 'café.txt'), 'accent', 'utf8');

    const status = await gitStatus(dir);
    // Without -z, git octal-escapes non-ASCII bytes: "caf\303\251.txt".
    expect(status.dirtyFiles).toEqual(['café.txt']);

    const result = await gitCommitPaths(dir, status.dirtyFiles!, 'commit café');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await gitStatus(dir);
    expect(after.dirty).toBe(false);
  });

  it('parses staged rename records (-z two-field format) without corrupting the list', async () => {
    const dir = await makeTmpDir('knip-gui-git-rename-');
    await initRepo(dir);
    await writeFile(join(dir, 'old-name.txt'), 'rename me', 'utf8');
    await writeFile(join(dir, 'other.txt'), 'other', 'utf8');
    await commitAll(dir, 'initial');

    // A staged rename emits the two-field `-z` record: `R  new\0old\0`. The
    // OLD path must be consumed with its record, not leak in as a phantom
    // entry or shift parsing of subsequent records.
    await git(dir, ['mv', 'old-name.txt', 'renamed.txt']);
    await writeFile(join(dir, 'other.txt'), 'other changed', 'utf8');

    const status = await gitStatus(dir);
    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles).toEqual(expect.arrayContaining(['renamed.txt', 'other.txt']));
    expect(status.dirtyFiles).toHaveLength(2);
  });

  it('reflects a newly created branch', async () => {
    const dir = await makeTmpDir('knip-gui-git-branch-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    await gitCreateBranch(dir, 'feature/sweep');

    const status = await gitStatus(dir);
    expect(status.branch).toBe('feature/sweep');
  });
});

describe('gitCreateBranch', () => {
  it('throws GitError when the branch already exists', async () => {
    const dir = await makeTmpDir('knip-gui-git-branch-dup-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    await gitCreateBranch(dir, 'dup-branch');
    await expect(gitCreateBranch(dir, 'dup-branch')).rejects.toBeInstanceOf(GitError);
  });
});

describe('gitCommitPaths', () => {
  it('commits only the listed paths, leaving other dirty files untouched, and includes a deleted path', async () => {
    const dir = await makeTmpDir('knip-gui-git-commit-');
    await initRepo(dir);
    await writeFile(join(dir, 'keep.txt'), 'keep me', 'utf8');
    await writeFile(join(dir, 'gone.txt'), 'delete me', 'utf8');
    await commitAll(dir, 'initial');

    // Change #1: modify a tracked file (to be committed).
    await writeFile(join(dir, 'keep.txt'), 'keep me v2', 'utf8');
    // Change #2: delete a tracked file (to be committed, via `git add --`).
    await unlink(join(dir, 'gone.txt'));
    // Change #3: an unrelated new file that must NOT be part of this commit.
    await writeFile(join(dir, 'untouched.txt'), 'leave me dirty', 'utf8');

    const before = await gitStatus(dir);
    expect(before.dirtyFiles).toEqual(expect.arrayContaining(['keep.txt', 'gone.txt', 'untouched.txt']));

    const result = await gitCommitPaths(dir, ['keep.txt', 'gone.txt'], 'commit keep + gone');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const { stdout: headSha } = await git(dir, ['rev-parse', 'HEAD']);
    expect(headSha.trim()).toBe(result.sha);

    const { stdout: showFiles } = await git(dir, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    const committedFiles = showFiles.split('\n').filter(Boolean).sort();
    expect(committedFiles).toEqual(['gone.txt', 'keep.txt']);

    const after = await gitStatus(dir);
    expect(after.dirty).toBe(true);
    expect(after.dirtyFiles).toEqual(['untouched.txt']);
  });

  it('throws GitError carrying the useful "nothing to commit" detail (git writes it to STDOUT)', async () => {
    const dir = await makeTmpDir('knip-gui-git-nothing-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    const error = await gitCommitPaths(dir, ['a.txt'], 'no-op commit').then(
      () => {
        throw new Error('expected gitCommitPaths to reject');
      },
      (e: unknown) => e as GitError,
    );
    expect(error).toBeInstanceOf(GitError);
    // git prints "nothing to commit, working tree clean" to stdout, not
    // stderr — the wrapper must still surface it so the API layer can show
    // the user a real reason instead of an empty string.
    expect(`${error.message}\n${error.stderr ?? ''}`).toContain('nothing to commit');
  });

  it('throws GitError on an empty paths list instead of committing whatever is already staged', async () => {
    const dir = await makeTmpDir('knip-gui-git-empty-paths-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    // Pre-stage an unrelated file: `git add --` with NO pathspec is a no-op,
    // so without a guard the subsequent commit would silently sweep this
    // staged file into a commit it was never asked to make.
    await writeFile(join(dir, 'stray.txt'), 'staged but not ours', 'utf8');
    await git(dir, ['add', 'stray.txt']);
    const { stdout: headBefore } = await git(dir, ['rev-parse', 'HEAD']);

    await expect(gitCommitPaths(dir, [], 'sneaky commit')).rejects.toBeInstanceOf(GitError);

    const { stdout: headAfter } = await git(dir, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(headBefore);
    const { stdout: staged } = await git(dir, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean)).toEqual(['stray.txt']);
  });

  it('throws GitError (not a silent no-op) when a path escapes the project root', async () => {
    const dir = await makeTmpDir('knip-gui-git-escape-');
    await initRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await commitAll(dir, 'initial');

    await writeFile(join(dir, 'a.txt'), 'changed', 'utf8');

    await expect(gitCommitPaths(dir, ['../outside.txt'], 'escape attempt')).rejects.toBeInstanceOf(GitError);
  });
});
