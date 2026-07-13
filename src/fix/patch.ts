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
// `../` traversal before touching the filesystem, and a realpath-based check
// catches a symlink that points outside the project (the same pattern used by
// /api/file in src/server/index.ts). When the target doesn't exist yet (a
// 'create' patch), realpathing the leaf alone is not enough: an ANCESTOR
// directory can be an escaping symlink (proj/linkdir -> /outside, target
// linkdir/newfile.txt), so walk up to the nearest existing ancestor and
// require its canonical path to be inside the root. The string check already
// covers the non-existent tail, and the subsequent recursive mkdir then only
// creates real directories under that verified ancestor. A symlinked ancestor
// whose canonical target stays INSIDE the project passes — containment is
// judged on the real write location, not the spelling of the path.
async function resolveContained(root: string, filePath: string): Promise<string> {
  const abs = resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes project root: ${filePath}`);
  }
  // Walk up from the target to the nearest path segment that exists on disk.
  // The loop terminates at `root`, which applyPatches has already realpathed
  // (so it exists); if even the root fails to resolve, surface that as an error.
  let existing = abs;
  let real: string;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch {
      if (existing === root) {
        throw new Error(`project root not accessible: ${root}`);
      }
      existing = dirname(existing);
    }
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
