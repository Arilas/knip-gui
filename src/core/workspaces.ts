import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function getWorkspaceDirs(projectDir: string): Promise<string[]> {
  const patterns = new Set<string>();

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    for (const p of ws ?? []) patterns.add(p);
  }

  const pnpmPath = join(projectDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmPath)) {
    for (const line of readFileSync(pnpmPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/);
      if (m) patterns.add(m[1]!);
    }
  }

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const abs = join(projectDir, base);
      if (!existsSync(abs)) continue;
      for (const d of readdirSync(abs, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(abs, d.name, 'package.json'))) dirs.add(`${base}/${d.name}`);
      }
    } else if (existsSync(join(projectDir, pattern, 'package.json'))) {
      dirs.add(pattern);
    }
  }

  return [...[...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b)), '.'];
}
