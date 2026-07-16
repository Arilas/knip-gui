import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Directories never treated as (or descended into while searching for) workspaces —
// they can contain thousands of nested package.json files that are not project
// workspaces, and a `**` glob would otherwise harvest all of them.
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Additionally skipped ONLY while expanding a `**` deep wildcard (#37):
// build-output trees are deep, churn constantly, and can contain stray
// package.json files (bundled fixtures, publish-staging dirs) that are not
// workspaces. Explicit patterns keep working — a literal or single-`*`
// segment still matches a directory named `dist`; only the unbounded `**`
// harvest refuses to descend into these.
const DEEP_GLOB_SKIP_DIRS = new Set([
  'dist', 'build', 'out', 'coverage',
  '.turbo', '.next', '.nuxt', '.output', '.cache', '.vite', '.svelte-kit',
]);

// Walk-result cache, keyed per project dir, fingerprinted on the mtime+size
// of both workspace manifests (#37): the walk used to rerun — synchronously,
// 100ms–2s on big trees — after EVERY post-apply rescan. Staleness contract
// (documented, accepted): creating or deleting a workspace DIRECTORY without
// touching either manifest (e.g. `mkdir packages/new` under an existing
// `packages/*` glob) is invisible until a manifest's mtime/size moves, the
// cache is cleared, or the process restarts. The hot path re-walks exactly
// when the glob SOURCE can have changed — workspace globs live only in the
// root package.json and pnpm-workspace.yaml.
interface CacheEntry { fingerprint: string; dirs: string[] }
const cache = new Map<string, CacheEntry>();

/** Test hook (and escape hatch for embedders): drop every cached walk. */
export function clearWorkspaceDirsCache(): void {
  cache.clear();
}

async function manifestFingerprint(projectDir: string): Promise<string> {
  const parts = await Promise.all(
    ['package.json', 'pnpm-workspace.yaml'].map(async (name) => {
      try {
        const s = await stat(join(projectDir, name));
        // size alongside mtimeMs so a same-timestamp-granule rewrite that
        // changes length still misses the cache.
        return `${name}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${name}:absent`;
      }
    }),
  );
  return parts.join('|');
}

export async function getWorkspaceDirs(projectDir: string): Promise<string[]> {
  const fingerprint = await manifestFingerprint(projectDir);
  const hit = cache.get(projectDir);
  // Copies on the way out (both branches): report/normalize consumers own
  // their array; a mutated return value must never poison the cache.
  if (hit && hit.fingerprint === fingerprint) return [...hit.dirs];

  const positive = new Set<string>();
  const negative = new Set<string>();

  for (const pattern of await collectPatterns(projectDir)) {
    if (pattern.startsWith('!')) {
      negative.add(pattern.slice(1).replace(/\/$/, ''));
    } else {
      positive.add(pattern.replace(/\/$/, ''));
    }
  }

  const dirs = new Set<string>();
  for (const pattern of positive) {
    for (const match of await expandPattern(projectDir, pattern)) dirs.add(match);
  }
  // Apply negative patterns against the fully-expanded set so `!packages/private`
  // (or `!packages/*`) actually excludes matches, rather than being silently dropped.
  for (const pattern of negative) {
    for (const match of [...dirs]) {
      if (matchesGlob(pattern.split('/'), match.split('/'))) dirs.delete(match);
    }
  }

  const result = [...[...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b)), '.'];
  cache.set(projectDir, { fingerprint, dirs: result });
  return [...result];
}

// Reads workspace globs from package.json (`workspaces` array or
// `workspaces.packages`) and pnpm-workspace.yaml (only the list under the
// top-level `packages:` key — other list-valued keys like `catalog:` /
// `onlyBuiltDependencies:` must not be mistaken for workspace globs).
async function collectPatterns(projectDir: string): Promise<string[]> {
  const patterns: string[] = [];

  try {
    const pkg = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(ws)) for (const p of ws) if (typeof p === 'string') patterns.push(p);
  } catch {
    // Absent or malformed package.json — treat as no workspaces rather than throwing.
  }

  let pnpmYaml: string | undefined;
  try {
    pnpmYaml = await readFile(join(projectDir, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    // No pnpm-workspace.yaml.
  }
  if (pnpmYaml !== undefined) {
    let inPackages = false;
    for (const line of pnpmYaml.split('\n')) {
      if (/^\S/.test(line)) inPackages = /^packages:\s*(#.*)?$/.test(line); // a new top-level key
      if (!inPackages) continue;
      const m = line.match(/^\s+-\s*['"]?([^'"#\s]+)['"]?/);
      if (m) patterns.push(m[1]!);
    }
  }

  return patterns;
}

// Expands one workspace glob into the project-relative directories that both match
// the pattern AND contain a package.json. Supports literal segments, single-segment
// `*` wildcards (`packages/*`, `apps/*/plugin`), and the `**` deep wildcard
// (`packages/**`, matching zero or more path segments).
async function expandPattern(projectDir: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  await walk(projectDir, '', pattern.split('/').filter(Boolean), out);
  return out;
}

// Concurrent pushes into `out` (the Promise.all fan-outs below) make its
// order nondeterministic; getWorkspaceDirs sorts the deduped set, so the
// final result is deterministic regardless.
async function walk(rootAbs: string, relSoFar: string, segments: string[], out: string[]): Promise<void> {
  if (segments.length === 0) {
    if (relSoFar) {
      try {
        await access(join(rootAbs, relSoFar, 'package.json'));
        out.push(relSoFar);
      } catch {
        // No package.json — matches the pattern but isn't a workspace.
      }
    }
    return;
  }
  const [seg, ...rest] = segments;
  const currentAbs = join(rootAbs, relSoFar);
  let entries: string[];
  try {
    entries = (await readdir(currentAbs, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {
    return; // not a readable directory
  }

  if (seg === '**') {
    // `**` matches zero segments (try the rest right here) and one-or-more (recurse
    // into each subdir keeping `**` at the head). Build-output dirs are pruned from
    // the recursion ONLY here — see DEEP_GLOB_SKIP_DIRS.
    await walk(rootAbs, relSoFar, rest, out);
    await Promise.all(
      entries
        .filter((name) => !DEEP_GLOB_SKIP_DIRS.has(name))
        .map((name) => walk(rootAbs, join(relSoFar, name), segments, out)),
    );
    return;
  }

  const re = segmentRegex(seg!);
  await Promise.all(
    entries.filter((name) => re.test(name)).map((name) => walk(rootAbs, join(relSoFar, name), rest, out)),
  );
}

// Compiles a single path segment glob (`*`, `foo*`, `foo`) to an anchored regex.
// `*` matches any run of characters within the one segment (no `/`).
function segmentRegex(seg: string): RegExp {
  const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

// Whether a project-relative path (as segments) matches a glob (as segments),
// used only to apply negative exclusion patterns to already-collected dirs.
function matchesGlob(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [seg, ...rest] = pattern;
  if (seg === '**') {
    for (let i = 0; i <= path.length; i++) {
      if (matchesGlob(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (!segmentRegex(seg!).test(path[0]!)) return false;
  return matchesGlob(rest, path.slice(1));
}
