/**
 * Secret scrubbing of free-text output fields (snippets, labels, headings, anchors). Some of them come from text no
 * view contains (JSON keys, `a[name]`, element ids), so each string is checked on its own with the same detectors as
 * the views. Detection results are memoised per string within one extraction.
 */
import type { SecretFinding } from '@olcys/core';
import { normaliseView } from '../normalise/normalise.ts';
import type { ViewText } from '../pipeline-types.ts';
import { redactText } from './redact.ts';
import { analyseSecrets } from './secrets.ts';

/** No secret kind is shorter than this (WIF 51, hex key 64, xprv 111, 12-word phrase ≥ 47 characters). */
const MIN_SECRET_LENGTH = 12;

function standaloneView(text: string): ViewText {
  return {
    captureId: 'scrub',
    view: 'visible_text',
    text,
    segments: [
      {
        start: 0,
        end: text.length,
        tag: '#text',
        path: '#text',
        inCode: false,
        quoted: false,
        hidden: false,
        blockIndex: 0,
        container: 0,
      },
    ],
    blocks: [{ index: 0, start: 0, end: text.length, tag: '#text', container: 0, headingPath: [] }],
    warnings: [],
  };
}

export class SecretScrubber {
  private readonly cache = new Map<string, SecretFinding[]>();
  /** Secret strings removed from output fields — in memory only, for the final leak guard. */
  readonly removed = new Set<string>();
  readonly kinds = new Set<SecretFinding['kind']>();

  /** Secrets the detectors find in `text` on its own. */
  find(text: string): SecretFinding[] {
    if (text.length < MIN_SECRET_LENGTH) return [];
    let found = this.cache.get(text);
    if (!found) {
      const view = standaloneView(text);
      found = analyseSecrets(view, normaliseView(view)).secrets.map((s) => s.finding);
      this.cache.set(text, found);
    }
    return found;
  }

  /** `text` with every detected secret replaced by `[REDACTED:<kind>]`. */
  scrub(text: string): string {
    const found = this.find(text);
    if (found.length === 0) return text;
    for (const f of found) {
      this.removed.add(text.slice(f.span.start, f.span.end));
      this.kinds.add(f.kind);
    }
    return redactText(text, found);
  }
}
