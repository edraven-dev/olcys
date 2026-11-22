import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/** Local Chromium: nothing is downloaded. `E2E_CHROMIUM` overrides; else `/usr/bin/chromium` when present. */
const executablePath =
  process.env['E2E_CHROMIUM'] ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: 'e2e/tests',
  outputDir: 'e2e/.results',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
