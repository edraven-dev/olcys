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

/**
 * Strict CSP of the production build (`vite preview`): same origin only, no inline script, no framing. The one
 * relaxation is CSS-only: Cytoscape (graph view) injects one fixed `<style>` element, allowed by its SHA-256 alone
 * (`style-src-elem`); stylesheets stay `'self'`, there is no `'unsafe-inline'`, and `script-src` stays `'self'`. The
 * dev server cannot run this policy (React Refresh injects an inline preamble and HMR opens a socket), so it gets the
 * other headers only.
 */
export const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
