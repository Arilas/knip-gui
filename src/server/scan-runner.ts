import { KnipError, type runScan } from '../core/knip-runner.js';
import { normalize } from '../core/normalize.js';
import { getWorkspaceDirs } from '../core/workspaces.js';
import type { ReportStore, StoreError } from './store.js';

export function toStoreError(e: unknown): StoreError {
  return e instanceof KnipError
    ? { code: e.code ?? 'knip-failed', message: e.message, stderr: e.stderr, exitCode: e.exitCode }
    : { code: 'internal', message: String(e) };
}

// The single scan→workspaces→normalize→store pipeline shared by the initial
// scan (/api/scan) and every rescan (post-apply fire-and-forget, post-sweep
// awaited). Both used to inline their own copy — including two divergent copies
// of the KnipError→StoreError mapping — so a change to the report shape (as
// happened when `scope` and `production` were added) had to be made twice or the
// two paths silently produced different reports. The caller is responsible only
// for the pre-scan latch (setScanning) and recording lastScanScope; this owns the
// begin/end-scan lifecycle and the ready/error landing.
export async function runScanIntoStore(opts: {
  store: ReportStore;
  scan: typeof runScan;
  projectDir: string;
  production: boolean;
  workspace?: string;
}): Promise<{ ok: true; issueCount: number } | { ok: false; error: StoreError }> {
  const { store, scan, projectDir, production, workspace } = opts;
  const controller = store.beginScan();
  try {
    const raw = await scan(projectDir, { workspace, production, signal: controller.signal });
    const workspaces = await getWorkspaceDirs(projectDir);
    const issues = normalize(raw, workspaces);
    store.setReady({ issues, scannedAt: new Date().toISOString(), workspaces, scope: workspace, production });
    return { ok: true, issueCount: issues.length };
  } catch (e) {
    const err = toStoreError(e);
    store.setError(err);
    return { ok: false, error: err };
  } finally {
    store.endScan(controller);
  }
}
