/**
 * The extractor's secret detection behind the core `SecretRedactor` port, for packages that must redact text before
 * storing it (collectors redact page bodies in memory). Secrets are searched in the raw text and in the parsed views
 * (HTML visible text and attributes, JSON strings), so a seed phrase split across elements is found too; every finding
 * is mapped back to the original text, and the union is redacted. Findings carry kinds and spans, never values.
 */
import type { RedactionResult, SecretRedactor } from '@olcys/core';
import { normaliseView } from './normalise/normalise.ts';
import { redactText } from './patterns/redact.ts';
import { detectSecrets } from './patterns/secrets.ts';
import type { ArtifactKind, SecretFinding } from '@olcys/core';
import type { ViewText } from './pipeline-types.ts';
import { buildViews } from './views/build.ts';

interface Range {
  start: number;
  end: number;
  kind: SecretFinding['kind'];
}

function plainTextView(text: string): ViewText {
  return {
    captureId: 'redactor',
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

/** Which structured views to build for a body without a media type. */
function structureOf(text: string): { kind: ArtifactKind; mediaType: string } | undefined {
  const head = text.trimStart().slice(0, 1);
  if (head === '{' || head === '[') return { kind: 'json', mediaType: 'application/json; charset=utf-8' };
  if (/<[a-z!/][^>]*>/i.test(text)) return { kind: 'html', mediaType: 'text/html; charset=utf-8' };
  return undefined;
}

/** Original-text ranges of the secrets found in the structured views (via each view's source map). */
function structuredRanges(text: string): Range[] {
  const structure = structureOf(text);
  if (!structure) return [];
  let views: ViewText[];
  try {
    views = buildViews({
      captureId: 'redactor',
      url: '',
      finalUrl: '',
      artifacts: [{ ...structure, bytes: new TextEncoder().encode(text) }],
    });
  } catch {
    // Unparsable structure: the raw-text scan still applies.
    return [];
  }
  const ranges: Range[] = [];
  for (const view of views) {
    const map = view.sourceMap;
    if (!map) continue;
    for (const finding of detectSecrets(view, normaliseView(view))) {
      let min = Number.POSITIVE_INFINITY;
      let max = -1;
      for (let i = finding.span.start; i < finding.span.end && i < map.length; i += 1) {
        const offset = map[i] ?? -1;
        if (offset < 0) continue;
        min = Math.min(min, offset);
        max = Math.max(max, offset);
      }
      if (max >= 0) ranges.push({ start: min, end: Math.min(text.length, max + 1), kind: finding.kind });
    }
  }
  return ranges;
}

function merge(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function createSecretRedactor(): SecretRedactor {
  return {
    redact(text: string): RedactionResult {
      if (!text) return { text, findings: [] };
      const raw = plainTextView(text);
      const ranges = merge([
        ...detectSecrets(raw, normaliseView(raw)).map((f) => ({ start: f.span.start, end: f.span.end, kind: f.kind })),
        ...structuredRanges(text),
      ]);
      if (ranges.length === 0) return { text, findings: [] };
      const findings: SecretFinding[] = ranges.map((r) => ({
        kind: r.kind,
        view: 'visible_text',
        span: { start: r.start, end: r.end },
      }));
      return {
        text: redactText(text, findings),
        findings: ranges.map((r) => ({ kind: r.kind, start: r.start, end: r.end })),
      };
    },
  };
}
