import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/client/**'],
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
