/**
 * Guard for the generated HTML: the report must not load anything (no scripts, stylesheets, frames, remote images or
 * fonts). Only in-document anchors (`href="#…"`) and `data:image/…` sources are allowed. Escaped text never contains
 * `<`, so only real tags and the report's own `<style>` are inspected.
 */
export class ExternalReferenceError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(`report is not self-contained: ${reference}`);
    this.name = 'ExternalReferenceError';
    this.reference = reference;
  }
}

const FORBIDDEN_TAG =
  /^<\s*\/?\s*(script|link|iframe|frame|frameset|object|embed|base|form|audio|video|source|track|svg|math|portal)\b/i;
const URL_ATTRIBUTE =
  /\s(src|href|action|formaction|poster|srcset|background|xlink:href|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function checkCss(css: string, where: string): void {
  if (/@import/i.test(css)) throw new ExternalReferenceError(`@import in ${where}`);
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = (match[2] ?? '').trim();
    if (!target.startsWith('data:')) throw new ExternalReferenceError(`url(${target}) in ${where}`);
  }
}

export function assertSelfContainedHtml(html: string): void {
  if (!/<meta http-equiv="Content-Security-Policy" content="default-src 'none'/.test(html))
    throw new ExternalReferenceError('missing Content-Security-Policy meta element');
  for (const [tag] of html.matchAll(/<[!/]?[A-Za-z][^>]*>/g)) {
    if (FORBIDDEN_TAG.test(tag)) throw new ExternalReferenceError(tag);
    for (const match of tag.matchAll(URL_ATTRIBUTE)) {
      const attribute = (match[1] ?? '').toLowerCase();
      const value = (match[3] ?? match[4] ?? match[5] ?? '').trim();
      if (attribute === 'href' && value.startsWith('#')) continue;
      if (attribute === 'src' && value.startsWith('data:image/')) continue;
      throw new ExternalReferenceError(`${attribute}="${value}"`);
    }
    const style = /\sstyle\s*=\s*"([^"]*)"/i.exec(tag);
    if (style) checkCss(style[1] ?? '', 'style attribute');
  }
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) checkCss(match[1] ?? '', '<style>');
}
