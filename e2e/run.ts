/**
 * `pnpm test:e2e [--screenshots] [playwright args]`: runs the acceptance suite (Playwright, local Chromium).
 * `--screenshots` also writes the README/pitch PNGs to docs/assets/screenshots/ (1440 px wide), with identifying data
 * masked; `--no-mask` switches the masking off (live rehearsal only).
 */
import { spawn } from 'node:child_process';
import { REPO_ROOT } from './state.ts';

const args = process.argv.slice(2);
const screenshots = args.includes('--screenshots');
const noMask = args.includes('--no-mask');
const rest = args.filter((arg) => arg !== '--screenshots' && arg !== '--no-mask');

const child = spawn(`${REPO_ROOT}/node_modules/.bin/playwright`, ['test', ...rest], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(screenshots ? { E2E_SCREENSHOTS: '1' } : {}),
    ...(noMask ? { E2E_NO_MASK: '1' } : {}),
    OLCYS_TELEMETRY: 'off',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  },
});
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
