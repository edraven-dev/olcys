import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/** The repository root: `WEB_PORT` and `API_PORT` live in the root `.env`, shared with the API (its CORS guard). */
const ROOT = resolve(import.meta.dirname, '..', '..');

export default defineConfig(({ mode }) => {
  // All variables (empty prefix), the process environment taking precedence over the root `.env` files.
  const env = { ...loadEnv(mode, ROOT, ''), ...process.env };
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${env.API_PORT || 4000}`,
      },
    },
  };
});
