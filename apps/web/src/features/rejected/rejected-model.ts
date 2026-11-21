/** Pure helpers for the rejected-addresses panel. */
import type { ExtractionResult, TextSpan, TextView } from '@olcys/core';

/** Stable reason code: the text before the first `:` (`checksum_invalid: bad bech32` → `checksum_invalid`). */
export function reasonCode(reason: string): string {
  return reason.split(':', 1)[0]?.trim() ?? '';
}

const codepoint = (char: string) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Distinct non-ASCII code points, e.g. `['U+0430']` for a Cyrillic "а" hidden in a bech32 address. */
export function nonAsciiCodepoints(raw: string): string[] {
  return [...new Set([...raw].filter((char) => (char.codePointAt(0) ?? 0) > 0x7e).map(codepoint))];
}

/** Splits a string into ASCII and non-ASCII runs so the latter can be highlighted. */
export function splitNonAscii(raw: string): { text: string; nonAscii: boolean; offset: number }[] {
  const parts: { text: string; nonAscii: boolean; offset: number }[] = [];
  let offset = 0;
  for (const char of raw) {
    const nonAscii = (char.codePointAt(0) ?? 0) > 0x7e;
    const last = parts.at(-1);
    if (last && last.nonAscii === nonAscii) last.text += char;
    else parts.push({ text: char, nonAscii, offset });
    offset += char.length;
  }
  return parts;
}

export interface RejectedCandidate {
  captureId: string;
  raw: string;
  reason: string;
  view: TextView;
  span: TextSpan;
}

/** Matches that failed address validation, deduplicated per capture and string. */
export function rejectedCandidates(results: readonly ExtractionResult[]): RejectedCandidate[] {
  const seen = new Set<string>();
  const out: RejectedCandidate[] = [];
  for (const result of results) {
    for (const rejected of result.rejected ?? []) {
      const key = `${result.captureId}|${rejected.raw}|${reasonCode(rejected.reason)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ captureId: result.captureId, ...rejected });
    }
  }
  return out;
}
