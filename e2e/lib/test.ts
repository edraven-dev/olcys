import { test as base } from '@playwright/test';
import { readState } from '../state.ts';

export { expect } from '@playwright/test';

/** `test` whose base URL is the console started by the global setup (free port, known only at run time). */
export const test = base.extend({
  // Playwright reads fixture dependencies from the destructuring pattern, so it must stay (empty).
  // oxlint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(readState().baseURL);
  },
});
