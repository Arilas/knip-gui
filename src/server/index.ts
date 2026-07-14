import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { KnipError, runScan } from '../core/knip-runner.js';
import { normalize } from '../core/normalize.js';
import { getWorkspaceDirs } from '../core/workspaces.js';
import { PlanStore } from '../fix/plan-store.js';
import { runSweep } from '../fix/sweep.js';
import { registerFixRoutes } from './routes-fix.js';
import { registerGitRoutes } from './routes-git.js';
import { registerIgnoresRoutes } from './routes-ignores.js';
import { ReportStore } from './store.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// `src/server/index.ts` and its compiled `dist/server/index.js` sit at the
// same depth (two levels) below the package root, so this resolves to
// `<package root>/dist/client` whether running from source (tests, tsx) or
// from the built package.
const DEFAULT_CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'client');

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function fallbackShell(token: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>knip-gui</title>` +
    `<meta name="knip-gui-token" content="${token}"></head>` +
    `<body><p>knip-gui server running. UI ships in a later phase.</p></body></html>`
  );
}

export function createServer(opts: {
  projectDir: string;
  scan?: typeof runScan;
  sweep?: typeof runSweep;
  clientDir?: string;
  /**
   * Fixed for the lifetime of this server instance (set from the CLI's
   * `--production` flag) and applied to every scan it runs, including
   * rescans — there is no per-request override.
   */
  production?: boolean;
}) {
  const { projectDir, scan = runScan, sweep = runSweep, clientDir = DEFAULT_CLIENT_DIR, production = false } = opts;
  const token = randomBytes(24).toString('hex');
  const store = new ReportStore();
  const planStore = new PlanStore();
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-knip-gui-token') !== token) return c.json({ error: 'unauthorized' }, 401);
    const origin = c.req.header('origin');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  });

  // Serves the Vite-built SPA shell with the real session token substituted
  // for the `__KNIP_GUI_TOKEN__` placeholder baked into the build (see
  // client/index.html); falls back to the Plan 1 inline shell when the client
  // hasn't been built (dist/client absent), e.g. in unit tests or a source
  // checkout that hasn't run `npm run build` yet.
  app.get('/', async (c) => {
    try {
      const html = await readFile(join(clientDir, 'index.html'), 'utf8');
      return c.html(html.replaceAll('__KNIP_GUI_TOKEN__', token));
    } catch {
      return c.html(fallbackShell(token));
    }
  });

  // Public static assets (js/css/etc emitted by the client build) — deliberately
  // NOT behind the /api/* token middleware, since these are just static bytes
  // and the API itself stays tokened.
  app.get('/assets/*', async (c) => {
    const root = resolve(clientDir, 'assets');
    const abs = resolve(root, c.req.path.replace(/^\/assets\//, ''));
    if (abs !== root && !abs.startsWith(root + sep)) return c.notFound();
    try {
      const data = await readFile(abs);
      const contentType = ASSET_CONTENT_TYPES[extname(abs)] ?? 'application/octet-stream';
      return c.body(data, 200, { 'content-type': contentType });
    } catch {
      return c.notFound();
    }
  });

  app.post('/api/scan', async (c) => {
    // Check-and-latch must be synchronous (no await between the status check
    // and setScanning), otherwise two concurrent requests both pass the guard
    // and both spawn a scan. Body parsing happens after latching, inside the
    // try block, so no failure path can leave the store stuck in 'scanning'.
    if (store.status === 'scanning') return c.json({ error: 'scan in progress' }, 409);
    store.setScanning();
    const controller = store.beginScan();
    try {
      const body = await c.req.json().catch(() => ({}));
      const workspace = typeof body.workspace === 'string' ? body.workspace : undefined;
      // Recorded before the scan runs (and kept even if it fails) so a
      // subsequent rescan reuses this scope instead of widening to the full
      // project — see ReportStore.lastScanScope.
      store.lastScanScope = workspace;
      const raw = await scan(projectDir, { workspace, production, signal: controller.signal });
      const workspaces = await getWorkspaceDirs(projectDir);
      const issues = normalize(raw, workspaces);
      store.setReady({ issues, scannedAt: new Date().toISOString(), workspaces, scope: workspace, production });
      return c.json({ status: 'ready', issueCount: issues.length });
    } catch (e) {
      const err = e instanceof KnipError
        ? { code: e.code ?? 'knip-failed', message: e.message, stderr: e.stderr, exitCode: e.exitCode }
        : { code: 'internal', message: String(e) };
      store.setError(err);
      return c.json({ status: 'error', error: err }, 500);
    } finally {
      store.endScan(controller);
    }
  });

  app.get('/api/report', (c) =>
    c.json({ status: store.status, report: store.report, error: store.error }),
  );

  app.get('/api/file', async (c) => {
    const rel = c.req.query('path') ?? '';
    const root = resolve(projectDir);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return c.json({ error: 'path outside project' }, 400);
    }

    // The string check above only catches `..` traversal. A symlink inside the
    // project can still point outside it, so compare canonical paths too. The
    // project root itself must also be canonicalized: on macOS /tmp is a
    // symlink to /private/tmp, so a naive startsWith against the raw root
    // would reject every legitimate file under a symlinked parent.
    let real: string;
    let realRoot: string;
    try {
      [real, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return c.json({ error: 'path outside project' }, 400);
    }

    try {
      const s = await stat(real);
      if (!s.isFile()) return c.json({ error: 'not a file' }, 404);
      if (s.size > MAX_FILE_BYTES) return c.json({ error: 'file too large' }, 413);
      return c.json({ path: rel, content: await readFile(real, 'utf8') });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  const fixCtx = { projectDir, scan, sweep, store, planStore, production };
  registerFixRoutes(app, fixCtx);
  registerGitRoutes(app, { projectDir });
  registerIgnoresRoutes(app, fixCtx);

  return { app, token, store };
}
