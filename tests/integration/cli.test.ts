import { describe, expect, it } from 'vitest';
import { startCli } from '../../src/cli.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;

describe('cli', () => {
  it('starts the server, serves the shell, and scans in the background', async () => {
    const { url, close, token } = await startCli({ dir: single, open: false, port: 0 });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const html = await (await fetch(url)).text();
      expect(html).toContain('knip-gui');

      let status = '';
      for (let i = 0; i < 120 && status !== 'ready'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const rep = await (await fetch(`${url}/api/report`, { headers: { 'x-knip-gui-token': token } })).json();
        status = rep.status;
      }
      expect(status).toBe('ready');
    } finally {
      await close();
    }
  });
});
