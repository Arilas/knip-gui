import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/**/*.test.ts'],
          // tests/e2e/**/*.spec.ts already wouldn't match the *.test.ts glob
          // above, but exclude it explicitly too — Playwright specs must
          // never run under vitest (they need a live browser + webServer).
          exclude: [...configDefaults.exclude, 'tests/client/**', 'tests/e2e/**'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'client',
          include: ['tests/client/**/*.test.ts'],
          environment: 'jsdom',
          testTimeout: 60_000,
        },
      },
    ],
  },
});
