import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// `root` is pinned to this file's own directory rather than left to default
// to process.cwd(), because the root `build:client` / `dev:client` npm
// scripts invoke `vite --config client/vite.config.ts` from the repo root.
const clientRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react(), tailwindcss()],
  build: {
    // Resolved relative to `root` above → <repo root>/dist/client, a sibling
    // of the server's own dist/ output (see src/server/index.ts's
    // DEFAULT_CLIENT_DIR, which expects exactly this layout).
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    // Dev-only: `npm run dev:client` runs the Vite dev server against a
    // separately-running `node dist/cli.js`/`tsx src/cli.ts` instance. The dev
    // server never sees the real session token (index.html isn't served
    // through the token-injecting GET / route in dev), so client/src/api.ts
    // must fall back to `import.meta.env.VITE_KNIP_TOKEN` in dev — set it to
    // the token printed by the CLI on startup. Production builds never read
    // that env var; the token always comes from the meta tag there.
    proxy: {
      '/api': {
        target: process.env.VITE_KNIP_GUI_SERVER ?? 'http://127.0.0.1:4800',
        changeOrigin: true,
      },
    },
  },
});
