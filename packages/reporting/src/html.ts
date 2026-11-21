/**
 * Minimal HTML templating with mandatory escaping. Every interpolated value is escaped unless it is `SafeHtml`
 * produced by this module, so scraped (untrusted) text can never reach the report as markup. Invisible and
 * direction-changing characters are shown as visible code points, so scraped text cannot hide or reorder content.
 * The tag is named `markup`, not `html`, so code formatters do not reflow the markup inside templates.
 */

export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type Html = SafeHtml | string | number | false | null | undefined | readonly Html[];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isInvisible(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    cp === 0x7f ||
    cp === 0xad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** `U+0430` style code point label. */
export function codePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function escapeHtml(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) out += `⟦${codePoint(cp)}⟧`;
    else out += ESCAPES[ch] ?? ch;
  }
  return out;
}

function render(value: Html): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return (value as readonly Html[]).map(render).join('');
  return escapeHtml(String(value));
}

/** Tagged template: literal parts are trusted markup, every interpolation is escaped. */
export function markup(strings: TemplateStringsArray, ...values: Html[]): SafeHtml {
  let out = strings[0] ?? '';
  for (const [i, value] of values.entries()) out += render(value) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

export function join(items: readonly Html[], separator: Html = ''): SafeHtml {
  const sep = render(separator);
  return new SafeHtml(items.map(render).join(sep));
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Fills a catalogue template (`'Wynik {score}/100'`). The template text and string values are escaped; `SafeHtml`
 * values are inserted as markup. A placeholder without a value is a bug and throws.
 */
export function t(template: string, vars: Record<string, Html> = {}): SafeHtml {
  let out = '';
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? '';
    if (!Object.hasOwn(vars, key)) throw new Error(`missing value for placeholder {${key}} in "${template}"`);
    out += escapeHtml(template.slice(last, match.index)) + render(vars[key]);
    last = match.index + match[0].length;
  }
  return new SafeHtml(out + escapeHtml(template.slice(last)));
}

/** Plain-text variant of `t` for values that are escaped later (e.g. table cells built from strings). */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`missing value for placeholder {${key}} in "${template}"`);
    return String(vars[key]);
  });
}
