/**
 * Length-preserving folding for lexicon matching: lower case and diacritics removed per UTF-16 unit
 * (ą→a, ł→l, ó→o, ż→z, …), so offsets in the folded text equal offsets in the input.
 */
const EXPLICIT = new Map([
  ['\u{0141}', 'l'],
  ['\u{0142}', 'l'],
  ['\u{00D8}', 'o'],
  ['\u{00F8}', 'o'],
  ['\u{0110}', 'd'],
  ['\u{0111}', 'd'],
]);
const cache = new Map<string, string>();

function foldUnit(unit: string): string {
  const cached = cache.get(unit);
  if (cached !== undefined) return cached;
  let out = EXPLICIT.get(unit);
  if (out === undefined) {
    const lower = unit.toLowerCase();
    const single = lower.length === 1 ? lower : unit;
    const base = single.normalize('NFD');
    out = base.length > 1 && /^\p{M}+$/u.test(base.slice(1)) && base[0] !== undefined ? base[0] : single;
  }
  cache.set(unit, out);
  return out;
}

export function foldText(text: string): string {
  let out = '';
  let asciiRun = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      asciiRun += 1;
      continue;
    }
    if (asciiRun > 0) {
      out += text.slice(i - asciiRun, i).toLowerCase();
      asciiRun = 0;
    }
    out += code >= 0xd800 && code <= 0xdfff ? text[i] : foldUnit(text[i] ?? '');
  }
  if (asciiRun > 0) out += text.slice(text.length - asciiRun).toLowerCase();
  return out;
}

/** Folds a whole word (NFD, marks removed, lower case); used for word lists, not for offsets. */
export function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('\u{0142}', 'l')
    .replaceAll('\u{0141}', 'l')
    .toLowerCase();
}
