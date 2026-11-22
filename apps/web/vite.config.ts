import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serverSettings } from './vite.settings.ts';

/** The repository root: `WEB_PORT` and `API_PORT` live in the root `.env`, shared with the API (its origin guard). */
const ROOT = resolve(import.meta.dirname, '..', '..');

export default defineConfig(({ mode }) => {
  const { port, apiTarget } = serverSettings(mode, ROOT, process.env);
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': apiTarget } },
  };
});
