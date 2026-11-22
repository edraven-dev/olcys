import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const TEST_FILE = /\.test\.tsx?$/;

function hasTests(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).some((file) => TEST_FILE.test(file));
}

// One Vitest project per workspace package/app that actually has tests (keeps output free of empty projects).
// A package may add its own vitest.config.ts (e.g. jsdom for apps/web).
const projects = ['packages', 'apps']
  .flatMap((root) => readdirSync(root).map((name) => join(root, name)))
  .filter((dir) => hasTests(join(dir, 'test')));

export default defineConfig({
  test: {
    projects: [...projects, { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } }],
    passWithNoTests: true,
  },
});
