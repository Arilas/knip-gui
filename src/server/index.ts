import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { KnipError, runScan } from '../core/knip-runner.js';
import { normalize } from '../core/normalize.js';
import { getWorkspaceDirs } from '../core/workspaces.js';
import { ReportStore } from './store.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function createServer(opts: { projectDir: string; scan?: typeof runScan }) {
  const { projectDir, scan = runScan } = opts;
  const token = randomBytes(24).toString('hex');
  const store = new ReportStore();
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-knip-gui-token') !== token) return c.json({ error: 'unauthorized' }, 401);
    const origin = c.req.header('origin');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  });

  app.get('/', (c) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>knip-gui</title>` +
      `<meta name="knip-gui-token" content="${token}"></head>` +
      `<body><p>knip-gui server running. UI ships in a later phase.</p></body></html>`,
    ),
  );

  app.post('/api/scan', async (c) => {
    if (store.status === 'scanning') return c.json({ error: 'scan in progress' }, 409);
    const body = await c.req.json().catch(() => ({}));
    store.setScanning();
    try {
      const raw = await scan(projectDir, { workspace: body.workspace });
      const workspaces = await getWorkspaceDirs(projectDir);
      const issues = normalize(raw, workspaces);
      store.setReady({ issues, scannedAt: new Date().toISOString(), workspaces });
      return c.json({ status: 'ready', issueCount: issues.length });
    } catch (e) {
      const err = e instanceof KnipError
        ? { code: e.code ?? 'knip-failed', message: e.message, stderr: e.stderr }
        : { code: 'internal', message: String(e) };
      store.setError(err);
      return c.json({ status: 'error', error: err }, 500);
    }
  });

  app.get('/api/report', (c) =>
    c.json({ status: store.status, report: store.report, error: store.error }),
  );

  app.get('/api/file', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = resolve(projectDir, rel);
    if (abs !== resolve(projectDir) && !abs.startsWith(resolve(projectDir) + sep)) {
      return c.json({ error: 'path outside project' }, 400);
    }
    try {
      const s = await stat(abs);
      if (!s.isFile()) return c.json({ error: 'not a file' }, 404);
      if (s.size > MAX_FILE_BYTES) return c.json({ error: 'file too large' }, 413);
      return c.json({ path: rel, content: await readFile(abs, 'utf8') });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  return { app, token, store };
}
