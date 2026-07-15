import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveKnip } from '../core/knip-runner.js';

export interface SweepOptions {
  workspace?: string;
  fixTypes?: string[];
  allowRemoveFiles?: boolean;
}

export interface SweepCapabilities {
  fix: boolean;
  fixType: boolean;
  allowRemoveFiles: boolean;
  workspace: boolean;
}

export function runSweep(
  projectDir: string,
  opts: SweepOptions & { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; stderr?: string }> {
  const knip = resolveKnip(projectDir);
  if (!knip) {
    return Promise.resolve({ ok: false, stderr: 'knip not found in project' });
  }

  const args = [knip.binPath, '--fix'];
  for (const fixType of opts.fixTypes ?? []) {
    args.push('--fix-type', fixType);
  }
  if (opts.allowRemoveFiles) args.push('--allow-remove-files');
  if (opts.workspace && opts.workspace !== '.') args.push('--workspace', opts.workspace);

  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      args,
      // `signal` lets the CLI's close() kill an in-flight `knip --fix` on shutdown
      // (it may be actively rewriting/deleting project files) instead of orphaning it.
      { cwd: projectDir, maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
      (error, _stdout, stderr) => {
        // A deliberate abort (server shutdown) surfaces as AbortError — not a real
        // sweep failure; report it distinctly so callers don't treat it as a crash.
        if (error?.name === 'AbortError') {
          return resolvePromise({ ok: false, stderr: 'sweep aborted' });
        }
        // Same exit-code discrimination as resolveKnip's runScan: 0 (clean)
        // and 1 (issues remain even after fixing what could be fixed) both
        // count as a successful sweep run; >=2 is a real knip error, and a
        // non-numeric error.code means the process never even started.
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code;
        if (error && typeof exitCode === 'number' && exitCode >= 2) {
          return resolvePromise({ ok: false, stderr });
        }
        if (error && typeof exitCode !== 'number') {
          return resolvePromise({ ok: false, stderr: String(error.message) });
        }
        resolvePromise({ ok: true, stderr: stderr || undefined });
      },
    );
  });
}

const capabilitiesCache = new Map<string, SweepCapabilities>();

export async function probeSweepCapabilities(projectDir: string): Promise<SweepCapabilities> {
  const cacheKey = resolve(projectDir);
  const cached = capabilitiesCache.get(cacheKey);
  if (cached) return cached;

  const knip = resolveKnip(projectDir);
  if (!knip) {
    // Do NOT cache this: knip absence is transient (the user may `npm i -D knip`
    // against a long-lived server), and a permanently-cached all-false would keep
    // sweep disabled until restart. Only successful probes below are cached.
    return { fix: false, fixType: false, allowRemoveFiles: false, workspace: false };
  }

  const helpText = await new Promise<string>((resolvePromise) => {
    execFile(
      process.execPath,
      [knip.binPath, '--help'],
      { cwd: projectDir, maxBuffer: 8 * 1024 * 1024 },
      (_error, stdout) => {
        resolvePromise(stdout);
      },
    );
  });

  const result: SweepCapabilities = {
    fix: /--fix\b/.test(helpText),
    fixType: /--fix-type\b/.test(helpText),
    allowRemoveFiles: /--allow-remove-files\b/.test(helpText),
    workspace: /--workspace\b/.test(helpText),
  };
  capabilitiesCache.set(cacheKey, result);
  return result;
}
