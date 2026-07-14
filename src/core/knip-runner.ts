import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export class KnipError extends Error {
  override name = 'KnipError';
  exitCode?: number;
  stderr?: string;
  code?: 'knip-not-found' | 'knip-failed' | 'bad-json' | 'aborted';
  constructor(message: string, props: Partial<KnipError> = {}) {
    super(message);
    Object.assign(this, props);
  }
}

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
      { cwd: projectDir, maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
      (error, stdout, stderr) => {
        // execFile's native `signal` support (Node >= 15.9) kills the child and
        // hands the callback an AbortError rather than a normal exit — surface
        // that distinctly so callers (e.g. the CLI's close()) don't mistake a
        // deliberate cancellation for a real knip failure.
        if (error?.name === 'AbortError') {
          return reject(new KnipError('scan aborted', { code: 'aborted', stderr }));
        }
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code;
        if (error && typeof exitCode === 'number' && exitCode >= 2) {
          return reject(new KnipError(`knip exited with ${exitCode}`, { code: 'knip-failed', exitCode, stderr }));
        }
        if (error && typeof exitCode !== 'number') {
          return reject(new KnipError(String(error.message), { code: 'knip-failed', stderr }));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new KnipError('knip produced invalid JSON', { code: 'bad-json', stderr }));
        }
      },
    );
  });
}
