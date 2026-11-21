/**
 * Comparison helpers for identifiers and links. They compare, they never validate addresses (checksums belong to the
 * address extractor).
 */

/** NFKC, lower case, `@` removed, runs of `-`, `_` and `.` folded to one `_` (`fikcyjny-kacper` ≡ `fikcyjny_kacper`). */
export function normaliseHandle(h: string): string {
  return h
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replaceAll('@', '')
    .replace(/[-_.]+/g, '_');
}

/** Name tokens without diacritics (`ł` → `l`), lower case, sorted: „Fikcyjny Kacper” ≡ „Kacper Fikcyjny”. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('ł', 'l')
    .replaceAll('Ł', 'L')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .toSorted();
}

/** Lower case without diacritics (`ł` → `l`): „Jestem” ≡ „jestem”, „użytkownik” ≡ „uzytkownik”. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('ł', 'l')
    .replaceAll('Ł', 'L')
    .toLowerCase();
}

export function sameName(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  return x.length > 0 && x.length === y.length && x.every((token, i) => token === y[i]);
}

export function normaliseEmail(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();
}

/**
 * Scheme-insensitive URL form for comparing links: lower-case host, default port dropped, no fragment, no trailing
 * `/`. Relative values resolve against `base`. `undefined` for anything that is not an http(s) URL.
 */
export function normaliseUrl(value: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim(), base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.host.toLowerCase()}${path}${url.search}`;
}

/** Same address string: exact, or case-insensitive for hex (`0x…`) and bech32 (`…1…` lower/upper) encodings. */
export function sameAddressText(value: string, address: string): boolean {
  const a = value.trim();
  if (a === address) return true;
  const caseInsensitive = /^0x[0-9a-f]+$/i.test(address) || /^[a-z]{1,83}1[02-9ac-hj-np-z]+$/i.test(address);
  return caseInsensitive && a.toLowerCase() === address.toLowerCase();
}

/** Property name without locator indexes: `profile.bitcoin_address[2]` → `profile.bitcoin_address`. */
export function baseProperty(property: string): string {
  return property.replace(/\[\d+\]/g, '');
}

/** Index of a repeated fact from its locator or property (`…#signed_message[1]` → `1`), default `0`. */
export function factIndex(locator: string, property: string): string {
  return /\[(\d+)\]$/.exec(locator)?.[1] ?? /\[(\d+)\]/.exec(property)?.[1] ?? '0';
}

/** Comparable token of a post anchor or page key: platform prefix dropped, only `[a-z0-9]` kept (`msg=65000101` → `msg65000101`). */
export function postToken(value: string): string {
  const withoutFragment = value.split('#')[0] ?? '';
  const colon = withoutFragment.indexOf(':');
  const local = colon >= 0 ? withoutFragment.slice(colon + 1) : withoutFragment;
  return local.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
