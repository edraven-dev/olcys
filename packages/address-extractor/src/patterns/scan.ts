/**
 * Candidate scanning over a normalised view: bounded per-chain patterns, a gap-tolerant joiner for split
 * addresses, hash-like hex strings and secrets. Matches overlapping a secret are dropped, never reported.
 */
import { NORMALISATION_TRANSFORMS, type NormalisationTransform } from '@olcys/core';
import { mapSpan } from '../normalise/normalise.ts';
import type { HashLike, NormalisedText, RawCandidate, ScanResult, SecretSpan, ViewText } from '../pipeline-types.ts';
import { segmentAt } from '../views/segments.ts';
import { GAP_ANCHORS, PATTERNS, type PatternDef } from './patterns.ts';
import { analyseSecrets, type Range } from './secrets.ts';

const TOKEN = /[0-9A-Za-z]+/g;
const GAP = /^[ \t\r\n\-_\u{00B7}\u{2022}|/]{1,3}$/u;
const MIN_CHUNK = 2;
const MAX_CHUNK = 20;
/** Enough 4-character groups for the longest bech32 address (90 characters, BIP-173). */
const MAX_JOIN_PARTS = 23;
const MAX_JOIN_LENGTH = 120;

function overlapsAny(ranges: readonly Range[], nStart: number, nEnd: number): boolean {
  return ranges.some((r) => nStart < r.nEnd && nEnd > r.nStart);
}

function withTransform(list: NormalisationTransform[], extra: NormalisationTransform): NormalisationTransform[] {
  const set = new Set([...list, extra]);
  return NORMALISATION_TRANSFORMS.filter((t) => set.has(t));
}

function candidate(
  view: ViewText,
  norm: NormalisedText,
  def: PatternDef,
  value: string,
  nStart: number,
  nEnd: number,
): RawCandidate {
  const { span, transforms } = mapSpan(norm, nStart, nEnd);
  return {
    patternId: def.id,
    family: def.family,
    value,
    view: view.view,
    nStart,
    nEnd,
    span,
    raw: view.text.slice(span.start, span.end),
    transforms,
  };
}

/** Joins short alphanumeric chunks separated by 1–3 separator characters within one container. */
function gapJoins(view: ViewText, norm: NormalisedText, secrets: readonly Range[]): RawCandidate[] {
  const text = norm.text;
  const tokens: { start: number; end: number; container: number }[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const length = match[0].length;
    tokens.push({
      start: match.index,
      end: match.index + length,
      container:
        length >= MIN_CHUNK && length <= MAX_CHUNK
          ? (segmentAt(view, norm.origStart[match.index] ?? 0)?.container ?? 0)
          : -1,
    });
  }
  const out: RawCandidate[] = [];
  const linked = (a: (typeof tokens)[number], b: (typeof tokens)[number]): boolean =>
    a.container >= 0 && a.container === b.container && GAP.test(text.slice(a.end, b.start));

  for (let i = 0; i < tokens.length; i += 1) {
    const first = tokens[i];
    if (!first || first.container < 0) continue;
    if (!GAP_ANCHORS.test(text.slice(first.start, first.end))) continue;
    let joined = text.slice(first.start, first.end);
    let previous = first;
    for (let j = i + 1; j < tokens.length && j - i < MAX_JOIN_PARTS; j += 1) {
      const next = tokens[j];
      if (!next || !linked(previous, next)) break;
      joined += text.slice(next.start, next.end);
      if (joined.length > MAX_JOIN_LENGTH) break;
      previous = next;
      if (overlapsAny(secrets, first.start, next.end)) break;
      for (const def of PATTERNS) {
        if (!def.full.test(joined)) continue;
        const raw = candidate(view, norm, def, joined, first.start, next.end);
        out.push({ ...raw, transforms: withTransform(raw.transforms, 'gap_joined'), joinedParts: j - i + 1 });
      }
    }
  }
  return out;
}

/** Scans one view with a given set of secret spans (which may include spans derived from other views). */
export function scanCandidates(
  view: ViewText,
  norm: NormalisedText,
  secrets: readonly SecretSpan[],
  hashes: readonly Range[],
): { candidates: RawCandidate[]; hashes: HashLike[] } {
  const secretRanges: Range[] = secrets.map((s) => ({ nStart: s.nStart, nEnd: s.nEnd }));
  const candidates: RawCandidate[] = [];
  for (const def of PATTERNS) {
    for (const match of norm.text.matchAll(def.scan)) {
      const nStart = match.index;
      const nEnd = match.index + match[0].length;
      if (overlapsAny(secretRanges, nStart, nEnd)) continue;
      candidates.push(candidate(view, norm, def, match[0], nStart, nEnd));
    }
  }
  candidates.push(...gapJoins(view, norm, secretRanges));
  const hashLike: HashLike[] = [];
  for (const h of hashes) {
    if (overlapsAny(secretRanges, h.nStart, h.nEnd)) continue;
    const { span } = mapSpan(norm, h.nStart, h.nEnd);
    hashLike.push({ value: norm.text.slice(h.nStart, h.nEnd), view: view.view, span });
  }
  return { candidates, hashes: hashLike };
}

/** Finds every address-like string, secret and hash-like hex string in one normalised view. */
export function scanView(view: ViewText, norm: NormalisedText): ScanResult {
  const { secrets, hashes } = analyseSecrets(view, norm);
  const scanned = scanCandidates(view, norm, secrets, hashes);
  return { candidates: scanned.candidates, secrets: secrets.map((s) => s.finding), hashes: scanned.hashes };
}
