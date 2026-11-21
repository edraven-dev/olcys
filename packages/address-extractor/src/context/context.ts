/**
 * Context record of a candidate: redacted ±200-character snippet within its container, nearest label and heading,
 * code flag, DOM anchor, role cues and page density / occurrence counts.
 */
import type { AddressCandidate, SecretFinding } from '@olcys/core';
import { redactText } from '../patterns/redact.ts';
import { SecretScrubber } from '../patterns/scrub.ts';
import type { AttributedCandidate, NormalisedText, ViewBlock, ViewSegment, ViewText } from '../pipeline-types.ts';
import { blockOf, containerRange, segmentAt } from '../views/segments.ts';
import { detectRoleCues } from './cues.ts';

export interface PageStats {
  /** Distinct valid canonical addresses in the capture (all views). */
  distinctAddresses: number;
  /** Key: canonical address. */
  occurrences: ReadonlyMap<string, number>;
  /** Key: `containerKey(view, container)`; distinct addresses per container. */
  containerAddressCounts: ReadonlyMap<string, number>;
}

/** Identifies one container of one view of one artifact (container numbers restart per artifact and view). */
export function containerKey(view: ViewText, container: number): string {
  return `${view.artifactIndex ?? 0}:${view.view}:${container}`;
}

const SNIPPET_CHARS = 200;
const LABEL_MAX = 60;
const LABEL_LINES = 3;
const GENERIC_HEADER = /^(?:code|kod|quote|cytat)\s*:?$/i;
const LABEL_LINE = /^(.*?)\s*[:\u{2013}\u{2014}-]$/u;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function jsonKeyLabel(pointer: string): string | undefined {
  const tokens = pointer
    .split('/')
    .slice(1)
    .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token && !/^\d+$/.test(token)) return token;
  }
  return undefined;
}

/** Nearest text before the address in its container that ends like a label („mój portfel USDT TRC20:”). */
function textLabel(view: ViewText, containerStart: number, candidateStart: number): string | undefined {
  const lines = view.text.slice(containerStart, candidateStart).split('\n');
  let inspected = 0;
  for (let i = lines.length - 1; i >= 0 && inspected < LABEL_LINES; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    inspected += 1;
    if (GENERIC_HEADER.test(line)) continue;
    const match = LABEL_LINE.exec(line);
    if (!match?.[1]) return undefined;
    const clause = (match[1].split(/(?<=[.!?])\s+/).at(-1) ?? '').trim();
    return clause.length > 0 && clause.length <= LABEL_MAX ? clause : undefined;
  }
  return undefined;
}

function labelOf(
  c: AttributedCandidate,
  view: ViewText,
  segment: ViewSegment | undefined,
  block: ViewBlock | undefined,
  containerStart: number,
): string | undefined {
  if (block?.structuralLabel) return block.structuralLabel;
  if (segment?.attribute?.startsWith('data-')) return segment.attribute;
  if (segment?.jsonPointer) return jsonKeyLabel(segment.jsonPointer);
  return textLabel(view, containerStart, c.span.start);
}

/** Replaces secret spans by spaces (same length) so lexicon matching never reads secret words. */
function maskSecrets(text: string, secrets: readonly SecretFinding[], offset: number): string {
  let out = text;
  for (const s of secrets) {
    const start = Math.max(0, s.span.start - offset);
    const end = Math.min(text.length, s.span.end - offset);
    if (end > start) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

export function buildContext(
  c: AttributedCandidate,
  view: ViewText,
  _norm: NormalisedText,
  secrets: readonly SecretFinding[],
  page: PageStats,
  scrubber: SecretScrubber = new SecretScrubber(),
): AddressCandidate['context'] {
  const segment = segmentAt(view, c.span.start);
  const block = blockOf(view, segment);
  const container = containerRange(view, c.span.start);
  let from = Math.max(container.start, c.span.start - SNIPPET_CHARS);
  let to = Math.min(container.end, c.span.end + SNIPPET_CHARS);
  if (from > 0 && isLowSurrogate(view.text.charCodeAt(from))) from -= 1;
  if (to < view.text.length && isLowSurrogate(view.text.charCodeAt(to))) to += 1;

  const window = view.text.slice(from, to);
  const nearby = secrets.filter((s) => s.span.start < to && s.span.end > from);
  // Every free-text field is scrubbed: labels, anchors and headings can come from text no view contains.
  const snippet = scrubber.scrub(redactText(window, nearby, from));
  const roleCues = detectRoleCues(maskSecrets(window, nearby, from), c.span.start - from, {
    quoted: segment?.quoted ?? false,
    ...(c.payment?.params['memo'] ? { memo: c.payment.params['memo'] } : {}),
    containerAddresses: page.containerAddressCounts.get(containerKey(view, container.container)) ?? 1,
    pageAddresses: page.distinctAddresses,
    candidateLength: c.span.end - c.span.start,
  });
  const rawLabel = labelOf(c, view, segment, block, container.start);
  const label = rawLabel === undefined ? undefined : scrubber.scrub(rawLabel);
  const rawHeading = block?.headingPath.at(-1);
  const heading = rawHeading === undefined ? undefined : scrubber.scrub(rawHeading);
  const anchor = segment?.anchor === undefined ? undefined : scrubber.scrub(segment.anchor);

  return {
    snippet,
    ...(label ? { label } : {}),
    ...(heading ? { heading } : {}),
    inCode: segment?.inCode ?? false,
    roleCues,
    pageAddressDensity: page.distinctAddresses,
    occurrencesInCapture: page.occurrences.get(c.canonical) ?? 1,
    ...(anchor ? { anchor } : {}),
  };
}
