import type { Hono } from 'hono';
import { GitError, gitCommitPaths, gitCreateBranch, gitStatus } from '../git/git.js';

export interface GitRoutesCtx {
  projectDir: string;
}

// GitError's stderr already carries the useful detail (git sometimes writes it
// to stdout instead — see GitError's own doc comment); a non-GitError failure
// (should not normally happen — execGit only ever rejects with GitError) falls
// back to String(e) so the route never throws.
function gitErrorBody(e: unknown): { error: string; stderr?: string } {
  if (e instanceof GitError) return { error: e.message, stderr: e.stderr };
  return { error: String(e) };
}

export function registerGitRoutes(app: Hono, ctx: GitRoutesCtx): void {
  const { projectDir } = ctx;

  app.get('/api/git/status', async (c) => {
    const status = await gitStatus(projectDir);
    return c.json(status);
  });

  app.post('/api/git/branch', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    try {
      await gitCreateBranch(projectDir, name);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(gitErrorBody(e), 400);
    }
  });

  app.post('/api/git/commit', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p: unknown): p is string => typeof p === 'string')
      : [];
    if (!message) return c.json({ error: 'message is required' }, 400);
    // An empty pathspec would make `git add --` a no-op, and the commit would
    // then sweep up whatever the caller happened to have staged already —
    // reject rather than commit someone else's staged changes under our message.
    if (paths.length === 0) return c.json({ error: 'paths is required' }, 400);
    try {
      // paths are validated as staying inside the project by gitCommitPaths
      // itself (assertContained) — no need to re-check here.
      const result = await gitCommitPaths(projectDir, paths, message);
      return c.json(result);
    } catch (e) {
      return c.json(gitErrorBody(e), 400);
    }
  });
}
