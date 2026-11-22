/**
 * Scraped text reaches the model only as delimited, inert data (OWASP LLM01). The text is normalised, invisible and
 * control characters are removed and anything that looks like a delimiter is neutralised before it is wrapped.
 */
import { createHash } from 'node:crypto';
import type { Sha256Hex } from '@olcys/core';

/** C0 controls except tab and newline, zero-width and bidi-control characters, the BOM. */
// oxlint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

export const UNTRUSTED_OPEN = '<<<UNTRUSTED_DATA';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_DATA';

export interface WrappedInput {
  /** The text to send as the user message. */
  content: string;
  /** First 16 hex characters of sha256(promptSha256 + sanitized). */
  nonce: string;
  /** The text between the markers. */
  sanitized: string;
}

export function sanitizeUntrusted(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replaceAll('<<<', '\u2039\u2039\u2039')
    .replaceAll('>>>', '\u203A\u203A\u203A');
}

/**
 * The nonce is deterministic (requests stay replayable) and still cannot be forged by the data: it depends on the
 * data itself, so the data cannot contain its own marker.
 */
export function wrapUntrusted(text: string, promptSha256: Sha256Hex): WrappedInput {
  const sanitized = sanitizeUntrusted(text);
  const nonce = createHash('sha256').update(promptSha256).update(sanitized).digest('hex').slice(0, 16);
  return {
    content: `${UNTRUSTED_OPEN} id=${nonce}>>>\n${sanitized}\n${UNTRUSTED_CLOSE} id=${nonce}>>>`,
    nonce,
    sanitized,
  };
}
