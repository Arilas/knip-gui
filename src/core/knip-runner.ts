import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export class KnipError extends Error {
  override name = 'KnipError';
  exitCode?: number;
  stderr?: string;
  code?: 'knip-not-found' | 'knip-failed' | 'bad-json' | 'aborted' | 'report-too-large';
  constructor(message: string, props: Partial<KnipError> = {}) {
    super(message);
    Object.assign(this, props);
  }
}

// knip's JSON reporter buffers the entire report in the child's stdout —
// large monorepos can exceed this before knip ever exits, at which point
// Node kills the child itself and the callback gets an
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER error rather than a real exit code.
// Exported so runScan's execFile option and the classifier's error message
// (and its unit tests) derive from one number instead of two copies of 64.
export const MAX_SCAN_BUFFER_BYTES = 64 * 1024 * 1024;

export function resolveKnip(projectDir: string): { binPath: string; version: string } | null {
  if (!existsSync(projectDir)) return null;
  try {
    // knip@6's "exports" map doesn't expose "./package.json" or "./bin/knip.js" as
    // subpaths, so require.resolve('knip/package.json', ...) throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED under Node's ESM-aware resolution. Resolve the
    // package's main entry instead (allowed via the "." export) and walk up to the
    // package root, then read package.json directly from disk.
    const require = createRequire(join(projectDir, 'noop.js'));
    const mainEntry = require.resolve('knip', { paths: [projectDir] }); // .../node_modules/knip/dist/index.js
    const knipRoot = dirname(dirname(mainEntry));
    const pkg = JSON.parse(readFileSync(join(knipRoot, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.knip;
    if (!bin) return null;
    return { binPath: join(knipRoot, bin), version: pkg.version };
  } catch {
    return null;
  }
}

export function runScan(
  projectDir: string,
  opts: { workspace?: string; production?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const knip = resolveKnip(projectDir);
  if (!knip) {
    return Promise.reject(new KnipError('knip not found in project', { code: 'knip-not-found' }));
  }
  const args = [knip.binPath, '--reporter', 'json'];
  if (opts.workspace && opts.workspace !== '.') args.push('--workspace', opts.workspace);
  if (opts.production) args.push('--production');

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: projectDir, maxBuffer: MAX_SCAN_BUFFER_BYTES, signal: opts.signal },
      (error, stdout, stderr) => {
        const knipError = classifyExecError(error, stderr);
        if (knipError) return reject(knipError);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new KnipError('knip produced invalid JSON', { code: 'bad-json', stderr }));
        }
      },
    );
  });
}

// Pure extraction of the execFile callback's error branching (Task A3 / GH
// #3), so each case can be unit-tested directly instead of only through a
// real child process — spawning one large enough to actually trip Node's
// maxBuffer kill would make for a slow, flaky test. Returns null when there's
// no error worth surfacing (including exit code 1, which just means "knip
// ran fine and found issues") — the caller then proceeds to JSON.parse(stdout).
export function classifyExecError(error: ExecFileException | null, stderr: string): KnipError | null {
  if (!error) return null;
  // execFile's native `signal` support (Node >= 15.9) kills the child and
  // hands the callback an AbortError rather than a normal exit — surface
  // that distinctly so callers (e.g. the CLI's close()) don't mistake a
  // deliberate cancellation for a real knip failure.
  if (error.name === 'AbortError') {
    return new KnipError('scan aborted', { code: 'aborted', stderr });
  }
  const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
  // Node kills the child and sets this code once stdout exceeds maxBuffer,
  // before knip ever gets to exit on its own — so there's no exit code to
  // read here. Checked ahead of the generic branches below (which would
  // otherwise catch it as an opaque non-numeric-code 'knip-failed', per the
  // original — now preserved-behavior — fallback). Older Node releases
  // didn't set this ERR_* code at all, only a message mentioning maxBuffer,
  // hence the OR.
  if (exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.message?.includes('maxBuffer')) {
    const maxMb = MAX_SCAN_BUFFER_BYTES / (1024 * 1024);
    return new KnipError(
      `knip's JSON report exceeded ${maxMb} MB — narrow the scan (--workspace) or scan a smaller project`,
      { code: 'report-too-large', stderr },
    );
  }
  if (typeof exitCode === 'number' && exitCode >= 2) {
    return new KnipError(`knip exited with ${exitCode}`, { code: 'knip-failed', exitCode, stderr });
  }
  if (typeof exitCode !== 'number') {
    return new KnipError(String(error.message), { code: 'knip-failed', stderr });
  }
  return null;
}
