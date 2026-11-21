/**
 * Typed facade over linkedom (its own typings return `any`) plus text helpers. Parsing is pure: the same stored HTML
 * always gives the same text, so re-parsing a capture reproduces its observations. Scraped text is data only.
 */
import { parseHTML } from 'linkedom';

export interface DomNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  readonly parentElement: DomElement | null;
}

export interface DomElement extends DomNode {
  readonly tagName: string;
  readonly nextElementSibling: DomElement | null;
  readonly previousElementSibling: DomElement | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  closest(selector: string): DomElement | null;
  matches(selector: string): boolean;
}

export interface DomDocument {
  readonly body: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export function parseHtml(html: string): DomDocument {
  return parseHTML(html).document as unknown as DomDocument;
}

export function all(root: DomDocument | DomElement, selector: string): DomElement[] {
  return Array.from(root.querySelectorAll(selector));
}

/** Direct element children, optionally of one tag. */
export function childElements(element: DomElement, tag?: string): DomElement[] {
  return Array.from(element.childNodes).filter(
    (n): n is DomElement => n.nodeType === ELEMENT_NODE && (!tag || (n as DomElement).tagName === tag.toUpperCase()),
  );
}

const ASCII_SPACE = /[\t\n\f\r ]+/g;
const EDGE_SPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

/** Collapses ASCII whitespace (not NBSP, which HTML keeps) and trims. */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(ASCII_SPACE, ' ').replace(EDGE_SPACE, '');
}

export function textOf(node: DomNode | null | undefined): string {
  return squash(node?.textContent);
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

export interface BlockTextOptions {
  /** Subtrees left out (e.g. quotes when reading a post's own text). */
  skip?: (element: DomElement) => boolean;
  /** Text for an image (e.g. forum smiley codes); images give no text by default. */
  image?: (element: DomElement) => string | undefined;
}

/**
 * Visible text with line structure: `<br>` and block boundaries become line breaks, other whitespace collapses as in
 * HTML rendering (except inside `<pre>`), lines are trimmed and runs of blank lines shortened.
 */
export function blockText(root: DomElement, options: BlockTextOptions = {}): string {
  const parts: string[] = [];
  const walk = (node: DomNode, pre: boolean): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = node.textContent ?? '';
      parts.push(pre ? data : data.replace(ASCII_SPACE, ' '));
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as DomElement;
    const tag = element.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag) || options.skip?.(element)) return;
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    if (tag === 'IMG') {
      const text = options.image?.(element);
      if (text) parts.push(text);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    for (const child of Array.from(element.childNodes)) walk(child, pre || tag === 'PRE');
    if (block) parts.push('\n');
  };
  for (const child of Array.from(root.childNodes)) walk(child, false);
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/^[\t\f\r ]+|[\t\f\r ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Absolute URL of an `href`, resolved against the page URL; undefined for non-HTTP links. */
export function absoluteHref(element: DomElement | null, pageUrl: string): string | undefined {
  const href = element?.getAttribute('href')?.trim();
  if (!href) return undefined;
  try {
    const url = new URL(href, pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** ISO 8601 UTC for a machine-readable `datetime` value (date-only values are kept as `YYYY-MM-DD`). */
export function isoDateTime(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Decodes a body with the charset of its content type (UTF-8 when absent or unknown). */
export function decodeBody(bytes: Uint8Array, contentType: string): { text: string; charset: string } {
  const label = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    // Unknown label: decode as UTF-8 and record which charset was used.
    return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8' };
  }
  return { text: decoder.decode(bytes), charset: label };
}
