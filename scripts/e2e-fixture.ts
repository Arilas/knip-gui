// Prepares a throwaway, git-initialized copy of tests/fixtures/single for the
// Playwright e2e run. Chained into playwright.config.ts's `webServer.command`
// (via `npm run e2e:fixture && ...`) rather than wired up as
// `config.globalSetup` — Playwright starts the `webServer` process BEFORE
// running `globalSetup` (see its own tests/playwright-test/web-server.spec.ts,
// which proves `globalSetup` can already fetch from a running webServer), so
// anything the CLI process needs on disk before it boots has to happen
// synchronously earlier in the same shell command, not in a globalSetup hook
// that would run too late.
//
// Recreated FRESH (rm -rf, then re-copy + re-init) on every invocation so
// repeated `npm run test:e2e` runs are deterministic: both e2e specs mutate
// this copy (the fix-loop spec removes `unusedHelper`/`orphan.ts`, the
// ignore-loop spec adds a knip.json entry for `left-pad`) and must each start
// from the same known-good state, never from whatever a previous run left
// behind.
//
// `--reap-only` skips the fixture work and only kills stray servers on the
// e2e port — see reapStrayServers' doc comment for why that step must ALSO
// run before `playwright test` itself (the `test:e2e` npm script), not just
// here inside the webServer command.
import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Keep in sync with playwright.config.ts's PORT.
const E2E_PORT = 4818;

const fixtureSrc = fileURLToPath(new URL('../tests/fixtures/single/', import.meta.url));
const workDir = fileURLToPath(new URL('../.tmp-tests/e2e-fixture/', import.meta.url));

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'inherit' });
}

function pidsOnPort(port: number): number[] {
  try {
    // -ti = terse PID-only output; exits non-zero when nothing is listening,
    // which is the common, healthy case — hence the try/catch.
    return execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // no listener on the port (or no lsof) — nothing to reap
  }
}

// Self-healing for stray servers: if a previous e2e run was killed abnormally
// (Ctrl-C mid-run, a crashed harness, an OOM'd shell), its `node dist/cli.js`
// child can survive and keep the e2e port bound — and Playwright's webServer
// (`reuseExistingServer: false`) then fails every subsequent run with "port
// already used" until someone kills it by hand.
//
// Crucially, Playwright performs that port check BEFORE launching the
// webServer command (verified by leaving a stray server on 4818: the run
// fails with "already used" without this script's fixture output ever
// appearing), so reaping inside the webServer command chain alone is too
// late. The `test:e2e` npm script therefore runs `--reap-only` FIRST, before
// `playwright test`; the reap also runs on the normal fixture path as
// belt-and-suspenders for anyone invoking `e2e:fixture` directly.
//
// darwin/linux only (lsof) — matches this repo's dev platforms; elsewhere
// this silently no-ops and Playwright's own port error still surfaces.
function reapStrayServers(port: number): void {
  const pids = pidsOnPort(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.warn(`e2e-fixture: killed stray process ${pid} holding port ${port}`);
    } catch {
      // Already gone, or not ours to kill — fall through to the wait below;
      // if the port stays bound Playwright's own error still surfaces.
    }
  }
  // SIGTERM is asynchronous — wait (up to ~2s) for the socket to actually
  // free before letting Playwright's port check run.
  const deadline = Date.now() + 2000;
  while (pidsOnPort(port).length > 0 && Date.now() < deadline) {
    execFileSync('sleep', ['0.1']);
  }
  const survivors = pidsOnPort(port);
  if (survivors.length > 0) {
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
        console.warn(`e2e-fixture: SIGKILLed unresponsive process ${pid} on port ${port}`);
      } catch {
        // nothing more we can do — Playwright will report the bound port
      }
    }
  }
}

async function main(): Promise<void> {
  reapStrayServers(E2E_PORT);
  if (process.argv.includes('--reap-only')) return;
  await rm(workDir, { recursive: true, force: true });
  await cp(fixtureSrc, workDir, { recursive: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'knip-gui e2e']);
  git(['config', 'user.email', 'e2e@knip-gui.local']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial fixture import']);
  console.log(`e2e fixture ready at ${workDir}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
