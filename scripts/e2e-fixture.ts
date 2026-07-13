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
import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtureSrc = fileURLToPath(new URL('../tests/fixtures/single/', import.meta.url));
const workDir = fileURLToPath(new URL('../.tmp-tests/e2e-fixture/', import.meta.url));

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'inherit' });
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await cp(fixtureSrc, workDir, { recursive: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'knip-gui e2e']);
  git(['config', 'user.email', 'e2e@knip-gui.local']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial fixture import']);
  console.log(`e2e fixture ready at ${workDir}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
