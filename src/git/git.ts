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

function execGit(
  cwd: string,
  args: string[],
  opts: { stdin?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code;
      if (error && typeof exitCode !== 'number') {
        return reject(new GitError(String(error.message), { stderr, code: 'spawn-failed' }));
      }
      if (error && typeof exitCode === 'number' && exitCode !== 0) {
        // git writes some failure detail to STDOUT rather than stderr (e.g.
        // `git commit` with nothing staged prints "nothing to commit, working
        // tree clean" on stdout) — prefer stderr, fall back to stdout, so
        // GitError always carries a useful message for the API layer.
        const detail = (stderr.trim() ? stderr : stdout).trim();
        return reject(
          new GitError(
            `git ${args.join(' ')} exited with ${exitCode}${detail ? `: ${detail}` : ''}`,
            { stderr: detail, code: `exit-${exitCode}` },
          ),
        );
      }
      resolvePromise({ stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      // If git exits before draining stdin, the write EPIPEs — swallow it;
      // the exit-code branch above reports the real failure.
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.stdin);
    }
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

// Parses NUL-delimited `git status --porcelain=v2 --branch -z` output — ONE
// exec now carries what `branch --show-current` + `status --porcelain -z`
// used to take two for (#37). With -z, paths are always verbatim (no
// C-quoting of spaces, no octal escapes for non-ASCII) — the same property
// the old v1 parser relied on for the gitStatus → gitCommitPaths round-trip.
//
// Record shapes (git-status(1), "Porcelain Format Version 2"):
//   `# <key> <value>`   headers; `# branch.head <name>` carries the branch,
//                       where `(detached)` means detached HEAD → undefined.
//   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`             changed
//   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`  rename/copy,
//       followed by a SEPARATE NUL-terminated field: the original path,
//       which must be consumed with its record (same two-field pitfall the
//       old v1 parser handled). We keep the new path.
//   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`   unmerged
//   `? <path>`                                                  untracked
//   `! <path>` (ignored) can't appear without --ignored; skipped if it does.
function parsePorcelainV2Z(stdout: string): { branch?: string; paths: string[] } {
  const fields = stdout.split('\0');
  let branch: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue; // trailing empty field after the final NUL
    if (record.startsWith('# ')) {
      const m = record.match(/^# branch\.head (.*)$/);
      if (m) branch = m[1] === '(detached)' ? undefined : m[1];
      continue;
    }
    const type = record[0];
    if (type === '1') {
      paths.push(restAfterNthSpace(record, 8));
    } else if (type === '2') {
      paths.push(restAfterNthSpace(record, 9));
      i++; // skip the rename/copy source field
    } else if (type === 'u') {
      paths.push(restAfterNthSpace(record, 10));
    } else if (type === '?') {
      paths.push(record.slice(2));
    }
  }
  return { branch, paths };
}

// The path is everything after the record's Nth space — indexOf-based so a
// path containing spaces is never split.
function restAfterNthSpace(record: string, n: number): string {
  let idx = 0;
  for (let k = 0; k < n; k++) idx = record.indexOf(' ', idx) + 1;
  return record.slice(idx);
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

  // One exec for branch + entries (#37). --untracked-files=normal, not
  // =all: `all` enumerates every file of every untracked tree (seconds on
  // big cold worktrees), while every consumer of dirtyFiles is display-only
  // (GitFooter's count, CommitBar's "other dirty files" warning) and the
  // commit flow posts plan paths, never dirtyFiles — so collapsed `dir/`
  // entries are an acceptable, cheaper answer.
  const statusResult = await execGit(projectDir, [
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
  ]);
  const { branch, paths: dirtyFiles } = parsePorcelainV2Z(statusResult.stdout);

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
  // Defense in depth (also guarded at the API layer): `git add --` with an
  // empty pathspec is a no-op, so an empty list would silently commit whatever
  // the caller already had staged in the index under this message.
  if (paths.length === 0) {
    throw new GitError('no paths given to commit', { code: 'empty-paths' });
  }
  const root = await realpath(resolve(projectDir));
  // Independent per-path checks — realpath walks, no shared state — so run
  // them concurrently instead of one await per path (#37). Promise.all
  // rejects with the first GitError, same observable contract as the loop.
  await Promise.all(paths.map((p) => assertContained(root, p)));

  // The commit itself is pathspec-scoped (`git commit -m <msg> -- <paths>`),
  // NOT a bare `git commit`: a bare commit commits the ENTIRE index, so
  // anything the user had pre-staged themselves (mid-edit on something
  // unrelated) would silently land in our commit under our message — exactly
  // the leak the empty-paths guard above describes, just via a non-empty
  // list. The pathspec form commits only the named paths' contents and
  // leaves every other index entry exactly as staged (verified: a pre-staged
  // unrelated file stays staged-but-uncommitted afterwards; regression-pinned
  // in tests/unit/git.test.ts).
  //
  // The `git add -- <paths>` beforehand is still required: a pathspec commit
  // of an UNTRACKED file fails with "pathspec ... did not match any file(s)
  // known to git" until the file is in the index (verified) — and it also
  // stages deletions (`git add` of a removed path records the removal).
  // `:(literal)` prefix disables git pathspec magic so a path is matched byte-for-
  // byte, never interpreted. Without it, `assertContained` (a filesystem-path check)
  // passes strings like `:/` (repo-root magic), `:(top)`, or a bare `*` that git then
  // expands to widen the commit past the requested files — defeating the scoping this
  // function exists to guarantee. A literal path that isn't a real file simply fails
  // to match instead of escaping scope. Pathspecs travel over stdin
  // (--pathspec-from-file=- --pathspec-file-nul, git >= 2.25) rather than argv: a
  // single commit's pathspec cannot be chunked across invocations, and ~10k paths as
  // argv brushes ARG_MAX (1MB on macOS including env). NUL separation keeps every
  // byte of a path literal — spaces, quotes, even newlines. Pathspec magic still
  // applies to stdin entries, so :(literal) keeps doing the scope-guarantee work
  // described above.
  const specsNul = paths.map((p) => `:(literal)${p}`).join('\0');
  const pathspecArgs = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  await execGit(projectDir, ['add', ...pathspecArgs], { stdin: specsNul });
  await execGit(projectDir, ['commit', '-m', message, ...pathspecArgs], { stdin: specsNul });
  const { stdout } = await execGit(projectDir, ['rev-parse', 'HEAD']);
  return { sha: stdout.trim() };
}
