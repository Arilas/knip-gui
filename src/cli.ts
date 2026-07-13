#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createServer } from './server/index.js';
import { resolveKnip } from './core/knip-runner.js';

export interface CliHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export async function startCli(opts: { dir: string; port: number; open: boolean }): Promise<CliHandle> {
  const { port, open } = opts;
  // A relative --dir must be anchored to cwd here: resolveKnip's createRequire
  // (and the server's path containment checks) require an absolute path, and a
  // relative one would silently report "knip not found".
  const dir = resolve(process.cwd(), opts.dir);
  const knip = resolveKnip(dir);
  if (!knip) {
    console.error('knip not found in this project. Install it first: npm i -D knip');
  } else {
    console.log(`Using knip ${knip.version}`);
  }

  const { app, token } = createServer({ projectDir: dir });

  let actualPort = port;
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
      actualPort = info.port;
      res(s);
    });
  });
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`knip-gui running at ${url}`);

  if (knip) {
    // Fire-and-forget initial scan: failures land in the store via /api/report,
    // there is nothing useful to do with the rejection here.
    fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'x-knip-gui-token': token, 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  }

  if (open) {
    // Never let the absence of a browser (headless CI, missing `open` handler) crash the CLI.
    (await import('open')).default(url).catch(() => {});
  }

  return {
    url,
    token,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

// Invoked as `node dist/cli.js` (or via the `knip-gui` bin symlink) rather than imported
// as a module. Node realpath-resolves the module file for import.meta.url but leaves
// process.argv[1] as the path the user invoked — for npm-link/global installs that is a
// symlinked bin shim — so argv[1] must be realpathed before comparing, or the CLI would
// silently exit 0 when run through its bin.
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    // argv[1] doesn't exist on disk (realpathSync throws) — fall back to a plain compare.
    return pathToFileURL(argv1).href === import.meta.url;
  }
}

if (isMain()) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      'no-open': { type: 'boolean', default: false },
      dir: { type: 'string', default: process.cwd() },
    },
  });
  startCli({
    dir: values.dir!,
    port: Number(values.port),
    open: !values['no-open'],
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
