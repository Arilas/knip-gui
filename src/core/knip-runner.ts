import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export class KnipError extends Error {
  override name = 'KnipError';
  exitCode?: number;
  stderr?: string;
  code?: 'knip-not-found' | 'knip-failed' | 'bad-json';
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

export function runScan(projectDir: string, opts: { workspace?: string } = {}): Promise<unknown> {
  const knip = resolveKnip(projectDir);
  if (!knip) {
    return Promise.reject(new KnipError('knip not found in project', { code: 'knip-not-found' }));
  }
  const args = [knip.binPath, '--reporter', 'json'];
  if (opts.workspace && opts.workspace !== '.') args.push('--workspace', opts.workspace);

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
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
