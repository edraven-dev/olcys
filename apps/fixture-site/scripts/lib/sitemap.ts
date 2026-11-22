/**
 * `sitemap.xml` of one variant: the persona pages of the manifest, for the mock search. Pages under `/private/` (the
 * robots.txt canary) and `/barriers/` are left out. Locations are relative to the sitemap itself (no leading slash)
 * because the site is served on several origins (host, compose, tests on a free port), possibly under a base path; the
 * mock search resolves them against the sitemap's own URL.
 */
import type { ManifestPage } from '../../src/manifest.ts';
import type { Variant } from '../../src/resolve.ts';
import { SYNTHETIC_MARK } from './chain.ts';

const EXCLUDED = ['/private/', '/barriers/'];

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function sitemapPaths(pages: readonly ManifestPage[], variant: Variant): string[] {
  return pages
    .filter((p) => p.variants.includes(variant) && !EXCLUDED.some((prefix) => p.path.startsWith(prefix)))
    .map((p) => p.path);
}

export function renderSitemap(pages: readonly ManifestPage[], variant: Variant): string {
  const urls = sitemapPaths(pages, variant).map(
    (path) => `  <url><loc>${escapeXml(path.replace(/^\/+/, ''))}</loc></url>\n`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<!-- ${SYNTHETIC_MARK}: persona pages of variant ${variant} for the mock search; locations relative to this file. -->\n` +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('') +
    '</urlset>\n'
  );
}
