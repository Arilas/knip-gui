import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { runScan } from '../core/knip-runner.js';
import { PlanStore } from '../fix/plan-store.js';
import { runSweep } from '../fix/sweep.js';
import { registerFixRoutes } from './routes-fix.js';
import { registerGitRoutes } from './routes-git.js';
import { registerIgnoresRoutes } from './routes-ignores.js';
import { readJsonObject } from './body.js';
import { runScanIntoStore } from './scan-runner.js';
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

// A Host header is loopback when its hostname (port stripped) is 127.0.0.1,
// localhost, or ::1 — the only hostnames a legitimate local client uses. A
// missing Host is treated as loopback so in-process test requests that omit it
// aren't rejected; real browsers always send one.
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  let hostname = host;
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end === -1 ? hostname : hostname.slice(1, end);
  } else {
    const colon = hostname.indexOf(':');
    if (colon !== -1) hostname = hostname.slice(0, colon);
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

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

  // DNS-rebinding defense. The server binds 127.0.0.1, but a malicious page can
  // rebind its own hostname to 127.0.0.1 and drive same-origin requests (which
  // carry no Origin header, so the /api/* origin check below never fires) to read
  // the token off `GET /` and then read arbitrary project files. The browser still
  // sends the ORIGINAL hostname in Host, so rejecting any non-loopback Host closes
  // that hole. Applied to every route (the shell hands out the token, so it must be
  // guarded too). Requests with no Host (browsers always send one over HTTP/1.1)
  // are treated as loopback so in-process test harnesses that omit it still work.
  app.use('*', async (c, next) => {
    if (!isLoopbackHost(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-knip-gui-token') !== token) return c.json({ error: 'unauthorized' }, 401);
    // Pinned to the exact request origin, not just "any loopback port": the SPA is
    // always served from this server's own origin, so a legitimate same-origin
    // request's Origin (when the browser sends one) is exactly `http://<Host>`. The
    // old `/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/` regex accepted ANY
    // loopback port, so a malicious page merely running on a different local port
    // (e.g. another dev server on 127.0.0.1:9999) sailed through it. The `*`
    // middleware above has already rejected non-loopback Host by this point
    // (isLoopbackHost), so Host is known-loopback here — this check reuses that
    // trusted Host to pin the comparison to this exact port rather than
    // re-verifying loopback-ness itself. Host is required whenever Origin is
    // present (real browsers that send Origin always send Host too); its hostname
    // is compared case-insensitively (DNS hostnames are case-insensitive) while the
    // port is compared exactly. No https allowance: this server only ever serves
    // plain http on loopback.
    const origin = c.req.header('origin');
    if (origin) {
      const host = c.req.header('host');
      if (!host || origin.toLowerCase() !== `http://${host}`.toLowerCase()) {
        return c.json({ error: 'forbidden origin' }, 403);
      }
    }
    await next();
  });

  // Any route that throws (a route with no try/catch, an fs error deep in a
  // transform) returns a JSON `{ error }` envelope instead of Hono's default
  // text/plain 500 — the client's apiFetch does res.json() and can only surface a
  // string `error`, so a text body would degrade to a generic "request failed".
  app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, 500));

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
    // Check-and-latch must be synchronous (no await between the tryBeginOp check
    // and acting on it), otherwise two concurrent requests both pass the guard and
    // both spawn a scan. tryBeginOp is shared with /api/sweep and every apply
    // route (see store.ts) so a scan can't run concurrently with any of those
    // either — all of them mutate the project or this store. readJsonObject can't
    // throw and runScanIntoStore owns the begin/end-scan lifecycle + error
    // landing, so the only thing this route itself must guarantee is endOp().
    if (!store.tryBeginOp('scan')) {
      return c.json({ error: `${store.activeOp} in progress`, op: store.activeOp }, 409);
    }
    try {
      store.setScanning();
      const body = await readJsonObject(c);
      const workspace = typeof body.workspace === 'string' ? body.workspace : undefined;
      // Recorded (and kept even if the scan fails) so a subsequent rescan reuses
      // this scope instead of widening to the full project — see lastScanScope.
      store.lastScanScope = workspace;
      const result = await runScanIntoStore({ store, scan, projectDir, production, workspace });
      if (!result.ok) return c.json({ status: 'error', error: result.error }, 500);
      return c.json({ status: 'ready', issueCount: result.issueCount });
    } finally {
      store.endOp();
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
