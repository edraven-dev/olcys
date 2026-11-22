import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { SECURITY_HEADERS, serverSettings, SPA_CSP } from './vite.settings.ts';

/** The repository root: `WEB_PORT` and `API_PORT` live in the root `.env`, shared with the API (its origin guard). */
const ROOT = resolve(import.meta.dirname, '..', '..');

export default defineConfig(({ mode }) => {
  const { host, port, apiTarget } = serverSettings(mode, ROOT, process.env);
  return {
    plugins: [react()],
    server: { host, port, strictPort: true, proxy: { '/api': apiTarget }, headers: SECURITY_HEADERS },
    // The production build is checked with the strict CSP (`pnpm --filter @olcys/web build && preview`).
    preview: {
      host,
      port,
      strictPort: true,
      proxy: { '/api': apiTarget },
      headers: { ...SECURITY_HEADERS, 'Content-Security-Policy': SPA_CSP },
    },
  };
});
