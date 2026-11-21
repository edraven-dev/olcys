import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every workspace package/app is its own test project; a package may add its own vitest.config.ts.
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
