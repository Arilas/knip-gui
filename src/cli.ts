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

export async function startCli(opts: { dir: string; port: number; open: boolean; production?: boolean }): Promise<CliHandle> {
  const { port, open, production = false } = opts;
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

  const { app, token, store } = createServer({ projectDir: dir, production });

  let actualPort = port;
  const server = await new Promise<ReturnType<typeof serve>>((res, rej) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
      actualPort = info.port;
      res(s);
    });
    // serve()'s callback only fires on success; a bind failure (EADDRINUSE on an
    // explicit --port) is emitted as an 'error' event that would otherwise be an
    // uncaught exception with a raw stack. Surface it as a rejection so startCli's
    // caller can print a friendly message.
    (s as { once?: (event: string, cb: (e: unknown) => void) => void }).once?.('error', rej);
  });
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`knip-gui running at ${url}`);

  if (knip) {
    // Fire-and-forget initial scan: the outcome lands in the store via
    // /api/report either way, so there's nothing to await here — but a failed
    // scan used to leave the CLI printing nothing at all, silently stranding a
    // terminal-only user. Print a one-line pointer at the UI (which has the
    // full stderr + setup help via SetupScreen) instead.
    fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'x-knip-gui-token': token, 'content-type': 'application/json' },
      body: '{}',
    })
      .then(async (res) => {
        if (res.ok) return;
        // Flat ErrorBody (api-types.ts): `error` is always the human-readable
        // string (a knip-failed KnipError's message already reads "knip
        // exited with N" — see classifyExecError — so there's no need to
        // special-case that code here the way the old structured body did).
        const body = await res.json().catch(() => undefined);
        const message = body?.error as string | undefined;
        console.error(`${message || 'scan failed'} — open the UI for details and setup help`);
      })
      .catch(() => {});
  }

  if (open) {
    // Never let the absence of a browser (headless CI, missing `open` handler) crash the CLI.
    (await import('open')).default(url).catch(() => {});
  }

  return {
    url,
    token,
    close: () =>
      new Promise<void>((res, rej) => {
        // Reap a stalled knip child (a stuck/slow scan or an in-flight
        // `knip --fix` sweep) before tearing the server down: aborting the
        // active signals kills their execFile children immediately (see
        // runScan/runSweep/ReportStore.abortActive), and
        // closeAllConnections forces any lingering keep-alive socket — e.g.
        // the fire-and-forget initial-scan request still parked mid-response
        // — shut so server.close()'s callback isn't left waiting on it.
        store.abortActive();
        // Only http.Server/https.Server (not Http2Server, which ServerType
        // also allows for) has closeAllConnections — guard for the type, we
        // only ever actually get a plain http.Server here since serve() below
        // is never given TLS/HTTP2 options.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((e) => (e ? rej(e) : res()));
      }),
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
      production: { type: 'boolean', default: false },
    },
  });

  const port = Number(values.port);
  // Number('') / Number('  ') is 0, not NaN, so an explicit trim-and-empty
  // check is needed alongside Number.isInteger to reject those the same way
  // as a genuinely non-numeric value like "abc".
  if (values.port!.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port: ${values.port}`);
    process.exit(1);
  }

  startCli({
    dir: values.dir!,
    port,
    open: !values['no-open'],
    production: values.production,
  }).catch((e) => {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EADDRINUSE') {
      console.error(`port ${port} is already in use — pass a different --port (or omit it for a random free port)`);
    } else if (code === 'EACCES') {
      console.error(`port ${port} needs elevated privileges — pass a --port ≥ 1024`);
    } else {
      console.error(e);
    }
    process.exit(1);
  });
}
