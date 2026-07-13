import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export class GitError extends Error {
  override name = 'GitError';
  stderr?: string;
  code?: string;
  constructor(message: string, props: Partial<GitError> = {}) {
    super(message);
    Object.assign(this, props);
  }
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  dirty?: boolean;
  dirtyFiles?: string[];
}

function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code;
      if (error && typeof exitCode !== 'number') {
        return reject(new GitError(String(error.message), { stderr, code: 'spawn-failed' }));
      }
      if (error && typeof exitCode === 'number' && exitCode !== 0) {
        return reject(
          new GitError(`git ${args.join(' ')} exited with ${exitCode}`, { stderr, code: `exit-${exitCode}` }),
        );
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

// Returns null instead of throwing when git itself fails (nonzero exit or
// spawn failure) — used for the "is this even a repo" probe, where failure is
// an expected, non-exceptional outcome rather than an error.
async function tryGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
  try {
    return await execGit(cwd, args);
  } catch {
    return null;
  }
}

// Parses one `git status --porcelain` line ("XY path" or, for renames,
// "XY old -> new") down to the path git currently considers ended.
function parsePorcelainPath(line: string): string {
  const path = line.slice(3);
  const arrowIdx = path.indexOf(' -> ');
  return arrowIdx === -1 ? path : path.slice(arrowIdx + 4);
}

export async function gitStatus(projectDir: string): Promise<GitStatus> {
  // `git rev-parse --show-toplevel` walks UP the directory tree looking for a
  // .git — so it happily succeeds for a plain subdirectory nested inside some
  // enclosing repo (e.g. this project's own working tree, or any other repo
  // the caller didn't intend to touch). We only want isRepo:true when
  // `projectDir` IS that repo's root, so we compare the reported toplevel
  // (realpathed, to also shake out symlinks) against the queried directory
  // itself and treat a mismatch as "not a repo" for our purposes.
  const toplevelResult = await tryGit(projectDir, ['rev-parse', '--show-toplevel']);
  if (!toplevelResult) return { isRepo: false };

  let dirReal: string;
  let toplevelReal: string;
  try {
    [dirReal, toplevelReal] = await Promise.all([
      realpath(resolve(projectDir)),
      realpath(toplevelResult.stdout.trim()),
    ]);
  } catch {
    return { isRepo: false };
  }
  if (dirReal !== toplevelReal) return { isRepo: false };

  const branchResult = await execGit(projectDir, ['branch', '--show-current']);
  const branch = branchResult.stdout.trim() || undefined;

  const statusResult = await execGit(projectDir, ['status', '--porcelain', '--untracked-files=all']);
  const dirtyFiles = statusResult.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parsePorcelainPath);

  return { isRepo: true, branch, dirty: dirtyFiles.length > 0, dirtyFiles };
}

export async function gitCreateBranch(projectDir: string, name: string): Promise<void> {
  await execGit(projectDir, ['checkout', '-b', name]);
}

// Resolves `relPath` against the (realpathed) repo root and confirms it stays
// inside it — same two-check pattern as src/fix/patch.ts's resolveContained:
// a string check catches `../` traversal, and a realpath-based check (walking
// up to the nearest existing ancestor, since the leaf may already be deleted
// on disk by the time we're asked to stage its removal) catches an escaping
// symlink.
async function assertContained(root: string, relPath: string): Promise<void> {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new GitError(`path escapes project root: ${relPath}`, { code: 'path-escape' });
  }

  let existing = abs;
  let real: string;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch {
      if (existing === root) {
        throw new GitError(`project root not accessible: ${root}`, { code: 'path-escape' });
      }
      existing = dirname(existing);
    }
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new GitError(`path escapes project root via symlink: ${relPath}`, { code: 'path-escape' });
  }
}

export async function gitCommitPaths(
  projectDir: string,
  paths: string[],
  message: string,
): Promise<{ sha: string }> {
  const root = await realpath(resolve(projectDir));
  for (const p of paths) {
    await assertContained(root, p);
  }

  await execGit(projectDir, ['add', '--', ...paths]);
  await execGit(projectDir, ['commit', '-m', message]);
  const { stdout } = await execGit(projectDir, ['rev-parse', 'HEAD']);
  return { sha: stdout.trim() };
}
