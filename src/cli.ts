#!/usr/bin/env node
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
  const { dir, port, open } = opts;
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
// as a module — compare against argv[1] via file URLs so this works whether cli.js is
// executed directly or through a symlinked bin shim.
const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
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
