/**
 * The production build contacts nothing but its own origin: no remote script, stylesheet, font or CDN in index.html or in
 * the bundles, no inline script or style (so the strict CSP holds), and the preview server sends that CSP.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type UserConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../vite.config.ts';
import { SECURITY_HEADERS, SPA_CSP } from '../vite.settings.ts';

const WEB = join(import.meta.dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'olcys-web-build-'));
const files = (): string[] =>
  readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(html|js|css|svg|webmanifest)$/.test(f));

/** URL hosts that appear in the bundles as XML namespaces or documentation strings, never requested. */
const INERT_HOSTS = new Set(['www.w3.org', 'react.dev', 'json-schema.org']);

beforeAll(async () => {
  // Vitest runs with NODE_ENV=test, which would bundle React's development build.
  const previous = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    await build({
      root: WEB,
      mode: 'production',
      logLevel: 'silent',
      configFile: join(WEB, 'vite.config.ts'),
      build: { outDir: out, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('production build', () => {
  it('index.html loads only same-origin scripts and styles and has no inline script or style', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(tag[1]).toMatch(/\bsrc=/);
      expect(tag[2]?.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('references no remote host in any asset (fonts, CDNs, analytics, @import)', () => {
    const hosts = new Set<string>();
    for (const f of files()) {
      const text = readFileSync(join(out, f), 'utf8');
      for (const m of text.matchAll(/(?:https?:\/\/|["'`(]\/\/)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g))
        hosts.add(m[1] ?? '');
      expect(text).not.toMatch(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
    }
    expect([...hosts].filter((h) => !INERT_HOSTS.has(h))).toEqual([]);
  });

  it('names no beacon, analytics or crash-report SDK', () => {
    const bundle = files()
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    expect(bundle).not.toMatch(/google-analytics|googletagmanager|sentry\.io|segment\.com|hotjar|mixpanel|plausible/i);
  });
});

describe('response headers of the web server', () => {
  it('forbid everything but the own origin in production (preview)', () => {
    expect(SPA_CSP).toContain("default-src 'self'");
    expect(SPA_CSP).toContain("frame-ancestors 'none'");
    // The only relaxation is CSS-only (one hashed `<style>` element of the graph library); scripts and stylesheets stay strict.
    expect(SPA_CSP).not.toMatch(/unsafe-|https?:|\*/);
    expect(SPA_CSP).toContain("script-src 'self'");
    expect(SPA_CSP).toContain("style-src 'self'");
    const { preview, server } = (config as (env: { mode: string; command: string }) => UserConfig)({
      mode: 'production',
      command: 'serve',
    });
    expect(preview?.headers).toMatchObject({ ...SECURITY_HEADERS, 'Content-Security-Policy': SPA_CSP });
    expect(server?.headers).toMatchObject(SECURITY_HEADERS);
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});
