import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface FilePatch {
  filePath: string; // repo-relative
  kind: 'modify' | 'delete' | 'create';
  hashBefore: string | null; // sha256 hex of current content; null for create
  contentAfter: string | null; // full new content; null for delete
}

export interface PatchResult {
  filePath: string;
  ok: boolean;
  reason?: 'stale' | 'missing' | 'io-error';
  detail?: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function hashFile(absPath: string): Promise<string | null> {
  try {
    const content = await readFile(absPath, 'utf8');
    return hashContent(content);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// Resolves `filePath` against the (realpathed) project root and confirms the
// result stays inside it. Two checks are needed: a string-based check catches
// `../` traversal before touching the filesystem, and — for paths that exist
// on disk — a realpath-based check catches a symlink inside the project that
// points outside it (the same pattern used by /api/file in src/server/index.ts).
async function resolveContained(root: string, filePath: string): Promise<string> {
  const abs = resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes project root: ${filePath}`);
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    // Doesn't exist yet (e.g. a 'create' target) — the string check above is
    // all we can do, and that's fine: there's no symlink to have escaped through.
    return abs;
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`path escapes project root via symlink: ${filePath}`);
  }
  return abs;
}

async function applyOne(root: string, patch: FilePatch): Promise<PatchResult> {
  try {
    const abs = await resolveContained(root, patch.filePath);

    const currentHash = await hashFile(abs);
    if (currentHash !== patch.hashBefore) {
      return {
        filePath: patch.filePath,
        ok: false,
        reason: currentHash === null ? 'missing' : 'stale',
      };
    }

    if (patch.kind === 'delete') {
      await rm(abs);
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, patch.contentAfter ?? '', 'utf8');
    }
    return { filePath: patch.filePath, ok: true };
  } catch (e) {
    return { filePath: patch.filePath, ok: false, reason: 'io-error', detail: String(e) };
  }
}

export async function applyPatches(projectDir: string, patches: FilePatch[]): Promise<PatchResult[]> {
  const root = await realpath(resolve(projectDir));
  return Promise.all(patches.map((patch) => applyOne(root, patch)));
}
