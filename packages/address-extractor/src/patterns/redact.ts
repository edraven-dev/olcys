/**
 * Redaction of secret spans. The marker is the only trace of a secret in any output.
 */
import type { SecretFinding, TextSpan } from '@olcys/core';

export const redactionMarker = (kind: SecretFinding['kind']): string => `[REDACTED:${kind}]`;

/** Marker used for bare spans without a kind. */
const GENERIC_MARKER = '[REDACTED:secret]';

/**
 * Replaces every secret span (original view offsets) in `text` with `[REDACTED:<kind>]`. `offset` is the position of
 * `text` in the view when a slice is redacted; spans reaching outside the slice are clipped (partial secrets are
 * redacted too). Overlapping spans are merged.
 */
export function redactText(text: string, secrets: readonly TextSpan[] | readonly SecretFinding[], offset = 0): string {
  const spans = (secrets as readonly (TextSpan | SecretFinding)[])
    .map((s) => {
      const span = 'span' in s ? s.span : s;
      return {
        start: Math.max(0, span.start - offset),
        end: Math.min(text.length, span.end - offset),
        marker: 'kind' in s ? redactionMarker(s.kind) : GENERIC_MARKER,
      };
    })
    .filter((s) => s.end > s.start)
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    if (s.end <= cursor) continue;
    if (s.start >= cursor) {
      out += text.slice(cursor, s.start) + s.marker;
    }
    cursor = Math.max(cursor, s.end);
  }
  return out + text.slice(cursor);
}
