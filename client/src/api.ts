// Thin typed wrapper over the server's /api/* routes (src/server/index.ts,
// routes-fix.ts, routes-git.ts). Every call sends the session token as
// `x-knip-gui-token` (Global Constraint: token only via the meta tag, never
// in the URL). Non-2xx responses throw ApiError so react-query's mutation
// error state / Toast (Task 5) can surface `body.error`/`body.stderr`.
//
// Cross-root type-only imports: verified `tsc -p client/tsconfig.json`
// resolves `../../src/**/*.ts` fine for `import type` (no rootDir/emit
// error, since client's tsconfig is noEmit), and Vite/esbuild elides
// type-only imports entirely, so there's no runtime dependency on files
// outside client/. Kept as the source of truth rather than a duplicated
// client/src/types.ts copy.
import type { Issue, Report } from '../../src/core/types.js';
import type { FixMode } from '../../src/core/types.js';
import type { StoreError } from '../../src/server/store.js';
import type { FixPlan, PlanItem } from '../../src/fix/compiler.js';
import type { PatchResult } from '../../src/fix/patch.js';
import type { SweepCapabilities } from '../../src/fix/sweep.js';
import type { GitStatus } from '../../src/git/git.js';
import type { IgnoreEntry, ListIgnoresResult } from '../../src/ignore/config-writer.js';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// Toast.tsx's error toasts (and CommitPanel's inline git-failure message) all
// funnel through here: every failing route in this app replies with a JSON
// body shaped `{ error, stderr? }` (routes-git.ts's gitErrorBody) or just
// `{ error }` (routes-fix.ts) — `body.error` is preferred since it's always a
// human-readable message, `stderr` is appended when present since it's the
// actual git output the message text summarized.
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; stderr?: unknown } | undefined;
    const message = typeof body?.error === 'string' ? body.error : err.message;
    const stderr = typeof body?.stderr === 'string' && body.stderr.trim() ? body.stderr.trim() : undefined;
    return stderr ? `${message}: ${stderr}` : message;
  }
  return err instanceof Error ? err.message : String(err);
}

// The literal placeholder baked into the built index.html (see
// client/index.html) — swapped for the real token at serve time by GET / in
// src/server/index.ts. The Vite dev server never does that substitution, so
// in dev the meta tag still holds this literal string; see VITE_KNIP_TOKEN
// below.
const TOKEN_PLACEHOLDER = '__KNIP_GUI_TOKEN__';

function getToken(): string {
  const metaContent = document.querySelector('meta[name="knip-gui-token"]')?.getAttribute('content') ?? '';
  if (metaContent && metaContent !== TOKEN_PLACEHOLDER) return metaContent;
  // Dev-only fallback (see client/vite.config.ts's dev proxy comment): set
  // VITE_KNIP_TOKEN to the token the CLI prints on startup. Never read in a
  // production build, where the meta tag always holds the real token.
  return import.meta.env.VITE_KNIP_TOKEN ?? '';
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'x-knip-gui-token': getToken() };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export interface ReportResponse {
  status: 'idle' | 'scanning' | 'ready' | 'error';
  report?: Report;
  error?: StoreError;
}

export function getReport(): Promise<ReportResponse> {
  return apiFetch<ReportResponse>('/api/report');
}

export interface ScanResponse {
  status: 'ready';
  issueCount: number;
}

export function postScan(workspace?: string): Promise<ScanResponse> {
  return postJson<ScanResponse>('/api/scan', workspace ? { workspace } : {});
}

export interface FileResponse {
  path: string;
  content: string;
}

export function getFile(path: string): Promise<FileResponse> {
  return apiFetch<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
}

export interface FixSelection {
  issueIds: string[];
  modeOverrides?: Record<string, FixMode>;
}

export interface PreviewResponse {
  planId: string;
  diffs: FixPlan['diffs'];
  items: PlanItem[];
}

export function postFixPreview(selection: FixSelection): Promise<PreviewResponse> {
  return postJson<PreviewResponse>('/api/fix/preview', selection);
}

export interface ApplyResponse {
  results: PatchResult[];
  failedItems: PlanItem[];
  rescanning: boolean;
}

export function postFixApply(planId: string): Promise<ApplyResponse> {
  return postJson<ApplyResponse>('/api/fix/apply', { planId });
}

export function postIgnorePreview(issueIds: string[]): Promise<PreviewResponse> {
  return postJson<PreviewResponse>('/api/ignore/preview', { issueIds });
}

export function postIgnoreApply(planId: string): Promise<ApplyResponse> {
  return postJson<ApplyResponse>('/api/ignore/apply', { planId });
}

export interface SweepOptions {
  workspace?: string;
  fixTypes?: string[];
  allowRemoveFiles?: boolean;
}

export interface SweepResponse {
  issueCount: number;
}

export function postSweep(opts: SweepOptions = {}): Promise<SweepResponse> {
  return postJson<SweepResponse>('/api/sweep', opts);
}

export function getSweepCapabilities(): Promise<SweepCapabilities> {
  return apiFetch<SweepCapabilities>('/api/sweep/capabilities');
}

export function getGitStatus(): Promise<GitStatus> {
  return apiFetch<GitStatus>('/api/git/status');
}

export function postGitBranch(name: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/api/git/branch', { name });
}

export function postGitCommit(message: string, paths: string[]): Promise<{ sha: string }> {
  return postJson<{ sha: string }>('/api/git/commit', { message, paths });
}

// --- Ignored page (Task 5) ---

export function getIgnores(): Promise<ListIgnoresResult> {
  return apiFetch<ListIgnoresResult>('/api/ignores');
}

// The preview/apply response shapes are identical to fix/ignore's — reusing
// PreviewResponse/ApplyResponse (rather than bespoke duplicate interfaces)
// keeps ActionModal-adjacent client code (DiffView, apply-flow's join
// helpers) directly reusable for the remove-ignore dialog too.
export function postIgnoreRemovePreview(entries: IgnoreEntry[]): Promise<PreviewResponse> {
  return postJson<PreviewResponse>('/api/ignores/remove/preview', { entries });
}

export function postIgnoreRemoveApply(planId: string): Promise<ApplyResponse> {
  return postJson<ApplyResponse>('/api/ignores/remove/apply', { planId });
}

export type { Issue, Report, FixMode, StoreError, PlanItem, PatchResult, SweepCapabilities, GitStatus, IgnoreEntry };
