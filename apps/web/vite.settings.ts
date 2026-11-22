import { loadEnv } from 'vite';

/**
 * Dev-server settings from `WEB_PORT` and `API_PORT`: the `.env` files in `envDir` (the repository root, shared with the
 * API) with the given process environment taking precedence.
 */
export function serverSettings(
  mode: string,
  envDir: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): { port: number; apiTarget: string } {
  const env = { ...loadEnv(mode, envDir, ''), ...processEnv };
  return { port: Number(env.WEB_PORT || 5173), apiTarget: `http://127.0.0.1:${env.API_PORT || 4000}` };
}
