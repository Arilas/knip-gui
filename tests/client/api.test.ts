// jsdom project (see vitest.config.ts) — api.ts reads the session token from
// a real <meta> tag in `document`, so this suite needs a DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'abc123token';

function setMetaToken(content: string): void {
  document.head.querySelectorAll('meta[name="knip-gui-token"]').forEach((el) => el.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'knip-gui-token');
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

beforeEach(() => {
  setMetaToken(TOKEN);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('api.ts', () => {
  it('sends the meta-tag token as x-knip-gui-token on every call', async () => {
    const { getReport } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { status: 'ready' }));
    await getReport();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/report');
    expect((init?.headers as Record<string, string>)['x-knip-gui-token']).toBe(TOKEN);
  });

  it('falls back to VITE_KNIP_TOKEN when the meta tag still holds the build placeholder', async () => {
    setMetaToken('__KNIP_GUI_TOKEN__');
    vi.stubEnv('VITE_KNIP_TOKEN', 'dev-token');
    const { getReport } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { status: 'ready' }));
    await getReport();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['x-knip-gui-token']).toBe('dev-token');
  });

  it('throws ApiError with status and body on a non-2xx response', async () => {
    const { getReport, ApiError } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    await expect(getReport()).rejects.toBeInstanceOf(ApiError);
    try {
      await getReport();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).status).toBe(401);
      expect((e as InstanceType<typeof ApiError>).body).toEqual({ error: 'unauthorized' });
    }
  });

  it('postScan posts the workspace in the body and returns the parsed json', async () => {
    const { postScan } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { status: 'ready', issueCount: 3 }));
    const result = await postScan('packages/a');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/scan');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ workspace: 'packages/a' });
    expect(result).toEqual({ status: 'ready', issueCount: 3 });
  });

  it('postScan omits workspace from the body when scanning the full project', async () => {
    const { postScan } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { status: 'ready', issueCount: 3 }));
    await postScan();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it('getFile encodes the path as a query param', async () => {
    const { getFile } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { path: 'src/a b.ts', content: 'x' }));
    await getFile('src/a b.ts');
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/file?path=src%2Fa%20b.ts');
  });

  it('postFixPreview posts issueIds and modeOverrides', async () => {
    const { postFixPreview } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { planId: 'p1', diffs: [], items: [] }));
    await postFixPreview({ issueIds: ['a', 'b'], modeOverrides: { a: 'delete-declaration' } });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/fix/preview');
    expect(JSON.parse(init?.body as string)).toEqual({ issueIds: ['a', 'b'], modeOverrides: { a: 'delete-declaration' } });
  });

  it('postFixApply posts the planId', async () => {
    const { postFixApply } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { results: [], failedItems: [], rescanning: true }));
    await postFixApply('p1');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/fix/apply');
    expect(JSON.parse(init?.body as string)).toEqual({ planId: 'p1' });
  });

  it('deleteFixPlan DELETEs the plan-scoped path and returns the parsed json', async () => {
    const { deleteFixPlan } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { deleted: true }));
    const result = await deleteFixPlan('p1');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/fix/plan/p1');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>)['x-knip-gui-token']).toBe(TOKEN);
    expect(result).toEqual({ deleted: true });
  });

  it('postIgnorePreview posts issueIds', async () => {
    const { postIgnorePreview } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { planId: 'p1', diffs: [], items: [] }));
    await postIgnorePreview(['a']);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/ignore/preview');
    expect(JSON.parse(init?.body as string)).toEqual({ issueIds: ['a'] });
  });

  it('postIgnoreApply posts the planId', async () => {
    const { postIgnoreApply } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { results: [], failedItems: [], rescanning: false }));
    await postIgnoreApply('p2');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/ignore/apply');
    expect(JSON.parse(init?.body as string)).toEqual({ planId: 'p2' });
  });

  it('postSweep posts fixTypes and allowRemoveFiles', async () => {
    const { postSweep } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { issueCount: 1 }));
    await postSweep({ fixTypes: ['exports'], allowRemoveFiles: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/sweep');
    expect(JSON.parse(init?.body as string)).toEqual({ fixTypes: ['exports'], allowRemoveFiles: true });
  });

  it('getSweepCapabilities GETs the capabilities endpoint', async () => {
    const { getSweepCapabilities } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { fix: true, fixType: true, allowRemoveFiles: true, workspace: true }),
    );
    const caps = await getSweepCapabilities();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/sweep/capabilities');
    expect(caps.fix).toBe(true);
  });

  it('getGitStatus GETs the git status endpoint', async () => {
    const { getGitStatus } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { isRepo: true, branch: 'main', dirty: false }));
    const status = await getGitStatus();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/git/status');
    expect(status.branch).toBe('main');
  });

  it('postGitBranch posts the branch name', async () => {
    const { postGitBranch } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));
    await postGitBranch('chore/cleanup');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/git/branch');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'chore/cleanup' });
  });

  it('postGitCommit posts message and paths', async () => {
    const { postGitCommit } = await import('../../client/src/api.js');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { sha: 'deadbeef' }));
    const result = await postGitCommit('chore: cleanup', ['src/a.ts']);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/git/commit');
    expect(JSON.parse(init?.body as string)).toEqual({ message: 'chore: cleanup', paths: ['src/a.ts'] });
    expect(result.sha).toBe('deadbeef');
  });

  // Session-expiry hook (Task 6 review fix): a 401 means the baked-in token
  // is dead (CLI restarted, old tab still open) — App.tsx registers a single
  // handler that swaps the UI for a session-expired notice. Pin that the
  // handler fires on exactly 401, not on other failures or successes.
  describe('setOnUnauthorized', () => {
    it('invokes the registered handler on a 401 response (and still throws ApiError)', async () => {
      const { getReport, setOnUnauthorized, ApiError } = await import('../../client/src/api.js');
      const handler = vi.fn();
      setOnUnauthorized(handler);
      try {
        vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
        await expect(getReport()).rejects.toBeInstanceOf(ApiError);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        setOnUnauthorized(undefined);
      }
    });

    it('does not invoke the handler on non-401 failures or on success', async () => {
      const { getReport, setOnUnauthorized } = await import('../../client/src/api.js');
      const handler = vi.fn();
      setOnUnauthorized(handler);
      try {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
        await expect(getReport()).rejects.toThrow();
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { status: 'ready' }));
        await getReport();
        expect(handler).not.toHaveBeenCalled();
      } finally {
        setOnUnauthorized(undefined);
      }
    });

    it('is a no-op (401 still just throws) when no handler is registered', async () => {
      const { getReport, ApiError } = await import('../../client/src/api.js');
      vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
      await expect(getReport()).rejects.toBeInstanceOf(ApiError);
    });
  });
});
