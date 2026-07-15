import type { Context } from 'hono';

// Parses a request's JSON body, always yielding a plain object. A malformed body,
// or a valid-but-non-object JSON value (`null`, `123`, `"x"`, `[...]`), collapses
// to `{}` so downstream `body.field` access never throws. Without this, a body of
// literal `null` parses fine yet `null.field` throws — on /api/scan that TypeError
// was caught and flipped a healthy 'ready' store to 'error'.
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => undefined);
  return body != null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
