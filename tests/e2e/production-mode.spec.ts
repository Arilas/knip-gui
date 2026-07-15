// Pins the sidebar "Production" badge (GitFooter.tsx, added Task 6 v0.3
// dogfood: `Report.production` existed since Task 1's `--production` CLI
// flag work, but nothing in the UI ever surfaced it — this spec is the
// regression pin for that gap, alongside a manual dogfood boot of this
// repo's own CLI in --production mode, see task-6-report.md).
//
// `report.production` is fixed for a server instance's whole lifetime (the
// CLI flag that started it), so it can't be toggled against the shared
// webServer (playwright.config.ts's, always started WITHOUT --production) —
// the "badge shows" case needs its own short-lived --production server
// against a throwaway fixture copy, same self-hosted pattern as
// workspace-switcher.spec.ts. The "badge absent" case reuses the shared
// (non-production) server directly.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const PORT = 4820; // one above workspace-switcher.spec.ts's 4819
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtureSrc = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const workDir = fileURLToPath(new URL('../../.tmp-tests/production-mode-fixture/', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let server: ChildProcess | undefined;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
}

function reapStrayServer(port: number): void {
  let pids: number[];
  try {
    pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

test.beforeAll(async () => {
  reapStrayServer(PORT);
  await rm(workDir, { recursive: true, force: true });
  await cp(fixtureSrc, workDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'knip-gui e2e']);
  git(['config', 'user.email', 'e2e@knip-gui.local']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial fixture import']);

  server = spawn('node', [cliPath, '--dir', workDir, '--no-open', '--port', String(PORT), '--production'], {
    stdio: 'ignore',
  });
  await waitForServer(`${BASE_URL}/`);
});

test.afterAll(async () => {
  server?.kill();
  await rm(workDir, { recursive: true, force: true });
});

test('the "Production" badge shows only when the server was started with --production', async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('production-badge')).toBeVisible();
  await expect(page.getByTestId('production-badge')).toHaveText('Production');
});

test('the badge is absent against the shared, non-production webServer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('production-badge')).toHaveCount(0);
});
