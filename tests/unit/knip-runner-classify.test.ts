import type { ExecFileException } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyExecError, MAX_SCAN_BUFFER_BYTES } from '../../src/core/knip-runner.js';

// classifyExecError is the pure extraction of runScan's execFile callback
// branching (Task A3 / GH #3) — covering it directly here means we don't need
// a fake child process large enough to actually trip Node's maxBuffer kill to
// exercise that branch.
function fakeError(props: Partial<ExecFileException>): ExecFileException {
  return Object.assign(new Error(props.message ?? 'fake'), props) as ExecFileException;
}

describe('classifyExecError', () => {
  it('returns null when there is no error (proceed to JSON parse)', () => {
    expect(classifyExecError(null, '')).toBeNull();
  });

  it('maps an AbortError to code "aborted", preserving stderr', () => {
    const err = fakeError({ name: 'AbortError', message: 'The operation was aborted' });
    const result = classifyExecError(err, 'partial output');
    expect(result?.code).toBe('aborted');
    expect(result?.message).toBe('scan aborted');
    expect(result?.stderr).toBe('partial output');
  });

  it('maps ERR_CHILD_PROCESS_STDIO_MAXBUFFER to code "report-too-large" with a sized message', () => {
    const err = fakeError({
      name: 'Error',
      message: 'stdout maxBuffer length exceeded',
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const result = classifyExecError(err, '');
    expect(result?.code).toBe('report-too-large');
    const mb = MAX_SCAN_BUFFER_BYTES / (1024 * 1024);
    expect(result?.message).toBe(
      `knip's JSON report exceeded ${mb} MB — narrow the scan (--workspace) or scan a smaller project`,
    );
  });

  it('also treats a message containing "maxBuffer" as report-too-large for older Node error shapes', () => {
    // Older Node versions didn't set a machine-readable `code` for this
    // failure — only the message mentioned "maxBuffer" — so the classifier
    // must catch that shape too, not just the modern ERR_* code.
    const err = fakeError({ name: 'Error', message: 'stdout maxBuffer length exceeded', code: undefined });
    const result = classifyExecError(err, '');
    expect(result?.code).toBe('report-too-large');
  });

  it('maps a numeric exit code >= 2 to "knip-failed" with exitCode set', () => {
    const err = fakeError({ name: 'Error', message: 'Command failed', code: 2 as unknown as string });
    const result = classifyExecError(err, 'stderr text');
    expect(result?.code).toBe('knip-failed');
    expect(result?.exitCode).toBe(2);
    expect(result?.message).toBe('knip exited with 2');
    expect(result?.stderr).toBe('stderr text');
  });

  it('leaves a numeric exit code of 1 unclassified (found issues, not a failure — proceed to JSON parse)', () => {
    const err = fakeError({ name: 'Error', message: 'Command failed', code: 1 as unknown as string });
    expect(classifyExecError(err, '')).toBeNull();
  });

  it('maps a non-numeric error code to "knip-failed" using the error message, without exitCode', () => {
    const err = fakeError({ name: 'Error', message: 'spawn ENOENT', code: 'ENOENT' });
    const result = classifyExecError(err, 'stderr text');
    expect(result?.code).toBe('knip-failed');
    expect(result?.exitCode).toBeUndefined();
    expect(result?.message).toBe('spawn ENOENT');
    expect(result?.stderr).toBe('stderr text');
  });
});
