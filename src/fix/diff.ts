import { createTwoFilesPatch } from 'diff';
import type { FilePatch } from './patch.js';

// Renders a unified diff for a single patch. `contentBefore` is the actual
// current file content (null when the file doesn't exist, i.e. for a fresh
// 'create'); FilePatch itself only carries a hash of the prior content, not
// the content, so callers that already have it on hand (e.g. from planning)
// pass it through here.
export function renderDiff(patch: FilePatch, contentBefore: string | null): string {
  const before = contentBefore ?? '';
  const after = patch.kind === 'delete' ? '' : (patch.contentAfter ?? '');
  return createTwoFilesPatch(patch.filePath, patch.filePath, before, after);
}
