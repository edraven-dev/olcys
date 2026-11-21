/**
 * Extraction of one capture: views → normalisation → secrets → candidates → validation → chain attribution →
 * context, assembled into the core `ExtractionResult`. Deterministic, synchronous inside and offline.
 * Secrets leave this module only as `SecretFinding` (kind, view, span); a final guard enforces it.
 */
import {
  newId as defaultNewId,
  TEXT_VIEWS,
  type AddressCandidate,
  type ExtractionResult,
  type Id,
  type SecretFinding,
  type TextSpan,
  type TextView,
} from '@olcys/core';
import { applyPageChain, attributeChains, pageChainPrior } from './attribution/cascade.ts';
import { findPaymentContexts, URI_RULES_VERSION } from './attribution/contexts.ts';
import { buildContext, containerKey, type PageStats } from './context/context.ts';
import { LEXICON_VERSION } from './context/lexicon.ts';
import type { DenyList } from './deny-list.ts';
import { normaliseView, toNormalised } from './normalise/normalise.ts';
import { PATTERNS_VERSION } from './patterns/patterns.ts';
import { scanCandidates } from './patterns/scan.ts';
import { SecretScrubber } from './patterns/scrub.ts';
import { analyseSecrets, type Range } from './patterns/secrets.ts';
import type {
  AttributedCandidate,
  CaptureContent,
  NormalisedText,
  RawCandidate,
  RejectedMatch,
  SecretSpan,
  ValidatedCandidate,
  ViewText,
} from './pipeline-types.ts';
import { resolveOverlaps, validateCandidate } from './validate/validate.ts';
import { buildViews } from './views/build.ts';
import { segmentAt, segmentsIn } from './views/segments.ts';

/** Bump on any pattern, lexicon or rule change (it is stored with every result). */
export const EXTRACTOR_VERSION = `0.1.0+${PATTERNS_VERSION}+${LEXICON_VERSION}+${URI_RULES_VERSION}`;

export interface ExtractOptions {
  /** Test vectors and documentation examples rejected as `documentation_example` (see `parseDenyList`). */
  denyList: DenyList;
  newId?: () => Id;
  /** Cap of the rejected list (default 500, warning `rejected_truncated:<n>`). */
  maxRejected?: number;
}

export type ExtractCaptureResult = ExtractionResult & { warnings: string[] };

/** Thrown when a secret fragment would leave the extractor — a bug: nothing may be persisted. */
export class SecretLeakError extends Error {
  constructor(fragments: number) {
    super(`secret leak guard: ${fragments} secret fragment(s) in the extraction result`);
    this.name = 'SecretLeakError';
  }
}

/** Higher priority first when the same occurrence is seen by several views. */
const VIEW_PRIORITY: readonly TextView[] = ['visible_text', 'attribute', 'meta', 'json_ld', 'inline_joined'];
const GUARD_WINDOW = 12;
const NOISE_CODES = new Set([
  'checksum_invalid',
  'length_invalid',
  'prefix_unknown',
  'witness_program_invalid',
  'bech32_variant_mismatch',
  'mixed_case',
]);

interface ViewState {
  view: ViewText;
  norm: NormalisedText;
  /** Own and derived secret spans (derived ones are redacted but not reported twice). */
  secrets: (SecretSpan & { derived?: boolean })[];
  hashes: Range[];
}

interface Occurrence<T> {
  item: T;
  state: ViewState;
  key: string;
  span: TextSpan;
  sources: { artifact: number; start: number; end: number }[];
  rank: number;
}

/** Exact source range of a match (from the per-character source map), else the ranges of its segments. */
function sourcesOf(state: ViewState, span: TextSpan): Occurrence<unknown>['sources'] {
  const artifact = state.view.artifactIndex ?? 0;
  const map = state.view.sourceMap;
  if (map) {
    let min = Number.POSITIVE_INFINITY;
    let max = -1;
    for (let i = span.start; i < Math.max(span.end, span.start + 1) && i < map.length; i += 1) {
      const offset = map[i] ?? -1;
      if (offset < 0) continue;
      min = Math.min(min, offset);
      max = Math.max(max, offset);
    }
    if (max >= 0) return [{ artifact, start: min, end: max + 1 }];
  }
  return segmentsIn(state.view, span.start, Math.max(span.end, span.start + 1))
    .filter((s) => s.source)
    .map((s) => ({ artifact, start: s.source?.start ?? 0, end: s.source?.end ?? 0 }));
}

function sameOccurrence<T>(a: Occurrence<T>, b: Occurrence<T>): boolean {
  if (a.key !== b.key) return false;
  if (a.sources.length === 0 || b.sources.length === 0) {
    return a.state === b.state && a.span.start < b.span.end && b.span.start < a.span.end;
  }
  return a.sources.some((x) => b.sources.some((y) => x.artifact === y.artifact && x.start < y.end && y.start < x.end));
}

/** Keeps the first occurrence (by rank) of every item seen by several views. */
function dedupe<T>(occurrences: Occurrence<T>[]): Occurrence<T>[] {
  const kept: Occurrence<T>[] = [];
  const byKey = new Map<string, Occurrence<T>[]>();
  for (const o of occurrences.toSorted((a, b) => a.rank - b.rank || a.span.start - b.span.start)) {
    const same = byKey.get(o.key) ?? [];
    if (same.some((k) => sameOccurrence(k, o))) continue;
    same.push(o);
    byKey.set(o.key, same);
    kept.push(o);
  }
  return kept;
}

function viewRank(view: TextView): number {
  const index = VIEW_PRIORITY.indexOf(view);
  return index < 0 ? VIEW_PRIORITY.length : index;
}

/** Output order of views (the core list order). */
function viewOrder(view: TextView): number {
  return TEXT_VIEWS.indexOf(view);
}

/** Locale-independent string order (results must be byte-identical across machines). */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** View reported for a span: `code` inside code segments (offsets stay in the view's text). */
function reportedView(state: ViewState, span: TextSpan): TextView {
  return state.view.view === 'visible_text' && segmentAt(state.view, span.start)?.inCode ? 'code' : state.view.view;
}

function overlapsSpan(a: Range, b: Range): boolean {
  return a.nStart < b.nEnd && b.nStart < a.nEnd;
}

/** Secrets seen in one view are redacted in every other view: by shared source range and by identical text. */
function propagateSecrets(states: ViewState[]): void {
  const own = states.flatMap((st) => st.secrets.map((s) => ({ st, s })));
  if (own.length === 0) return;
  const strings = new Map<string, SecretFinding['kind']>();
  for (const { st, s } of own) {
    const original = st.view.text.slice(s.finding.span.start, s.finding.span.end);
    const normalised = st.norm.text.slice(s.nStart, s.nEnd);
    for (const value of [original, normalised]) if (value.length >= GUARD_WINDOW) strings.set(value, s.finding.kind);
  }
  const sources = own.flatMap(({ st, s }) =>
    sourcesOf(st, s.finding.span).map((src) => Object.assign(src, { kind: s.finding.kind })),
  );

  for (const st of states) {
    const derived: ViewState['secrets'] = [];
    const add = (kind: SecretFinding['kind'], start: number, end: number): void => {
      const nStart = toNormalised(st.norm, start);
      const nEnd = Math.max(nStart, toNormalised(st.norm, end));
      const range = { nStart, nEnd };
      if (
        nEnd <= nStart ||
        st.secrets.some((s) => overlapsSpan(s, range)) ||
        derived.some((s) => overlapsSpan(s, range))
      ) {
        return;
      }
      derived.push({ finding: { kind, view: st.view.view, span: { start, end } }, nStart, nEnd, derived: true });
    };
    const artifact = st.view.artifactIndex ?? 0;
    const map = st.view.sourceMap;
    for (const src of sources) {
      if (src.artifact !== artifact || !map) continue;
      // Exact characters of the secret in this view (separators inside the run are included).
      let runStart = -1;
      let runEnd = -1;
      for (let p = 0; p <= map.length; p += 1) {
        const offset = p < map.length ? (map[p] ?? -1) : -2;
        if (offset >= src.start && offset < src.end) {
          if (runStart < 0) runStart = p;
          runEnd = p + 1;
        } else if (offset !== -1 && runStart >= 0) {
          add(src.kind, runStart, runEnd);
          runStart = -1;
        }
      }
    }
    for (const [value, kind] of strings) {
      for (let at = st.view.text.indexOf(value); at >= 0; at = st.view.text.indexOf(value, at + value.length)) {
        add(kind, at, at + value.length);
      }
    }
    st.secrets.push(...derived);
  }
}

/** Failed readings that are pure noise: speculative joins, all-digit runs, fragments of base64 blobs. */
function isNoise(raw: RawCandidate, rejected: RejectedMatch, norm: NormalisedText): boolean {
  const code = rejected.reason.split(':')[0] ?? '';
  if (raw.transforms.includes('gap_joined')) return code !== 'gap_joined_weak_checksum';
  if (!NOISE_CODES.has(code)) return false;
  if (/^\d+$/.test(raw.value)) return true;
  let start = raw.nStart;
  let end = raw.nEnd;
  while (start > 0 && /[A-Za-z0-9+/=]/.test(norm.text[start - 1] ?? '')) start -= 1;
  while (end < norm.text.length && /[A-Za-z0-9+/=]/.test(norm.text[end] ?? '')) end += 1;
  const around = norm.text.slice(start, raw.nStart) + norm.text.slice(raw.nEnd, end);
  return /[+=]/.test(around);
}

function guardStrings(result: ExtractCaptureResult): string[] {
  const out: string[] = [];
  for (const c of result.candidates) {
    out.push(c.raw, c.context.snippet);
    if (c.chainAttribution.detail) out.push(c.chainAttribution.detail);
    if (c.context.label) out.push(c.context.label);
    if (c.context.heading) out.push(c.context.heading);
    if (c.context.anchor) out.push(c.context.anchor);
  }
  for (const r of result.rejected) out.push(r.raw, r.reason);
  return out;
}

/**
 * Throws `SecretLeakError` when any output string contains a 12-character fragment of a known secret, or anything
 * the secret detectors flag when run on that string on its own.
 */
function assertNoSecretLeak(result: ExtractCaptureResult, states: ViewState[], scrubber: SecretScrubber): void {
  const fragments = new Set<string>();
  for (const value of scrubber.removed) {
    for (let i = 0; i + GUARD_WINDOW <= value.length; i += 1) fragments.add(value.slice(i, i + GUARD_WINDOW));
  }
  for (const st of states) {
    for (const s of st.secrets) {
      if (s.derived) continue;
      for (const value of [
        st.view.text.slice(s.finding.span.start, s.finding.span.end),
        st.norm.text.slice(s.nStart, s.nEnd),
      ]) {
        for (let i = 0; i + GUARD_WINDOW <= value.length; i += 1) fragments.add(value.slice(i, i + GUARD_WINDOW));
      }
    }
  }
  let leaks = 0;
  for (const text of guardStrings(result)) {
    if (scrubber.find(text).length > 0) leaks += 1;
    if (fragments.size === 0) continue;
    for (let i = 0; i + GUARD_WINDOW <= text.length; i += 1) {
      if (fragments.has(text.slice(i, i + GUARD_WINDOW))) leaks += 1;
    }
  }
  if (leaks > 0) throw new SecretLeakError(leaks);
}

function extract(content: CaptureContent, options: ExtractOptions): ExtractCaptureResult {
  const newId = options.newId ?? (() => defaultNewId());
  const maxRejected = options.maxRejected ?? 500;
  const views = buildViews(content);
  const warnings = new Set(views.flatMap((v) => v.warnings));

  const states: ViewState[] = views.map((view) => {
    const norm = normaliseView(view);
    const analysis = analyseSecrets(view, norm);
    return { view, norm, secrets: analysis.secrets, hashes: analysis.hashes };
  });
  propagateSecrets(states);

  const attributedByView = new Map<ViewState, AttributedCandidate[]>();
  const rejected: Occurrence<RejectedMatch>[] = [];
  const addRejected = (state: ViewState, r: RejectedMatch): void => {
    rejected.push({
      item: r,
      state,
      key: `${r.reason}|${r.raw}`,
      span: r.span,
      sources: sourcesOf(state, r.span),
      rank: viewRank(state.view.view),
    });
  };

  for (const state of states) {
    const { view, norm } = state;
    const scanned = scanCandidates(view, norm, state.secrets, state.hashes);
    const valid: ValidatedCandidate[] = [];
    const failed: RejectedMatch[] = [];
    for (const raw of scanned.candidates) {
      const result = validateCandidate(raw, { denyList: options.denyList });
      if (result.ok) valid.push(result.value);
      else if (!isNoise(raw, result.rejected, norm)) failed.push(result.rejected);
    }
    const resolved = resolveOverlaps(valid, failed);
    const attribution = attributeChains({
      candidates: resolved.valid,
      contexts: findPaymentContexts(view, norm),
      view,
      norm,
    });
    attributedByView.set(state, attribution.attributed);
    for (const r of [...resolved.rejected, ...attribution.rejected]) addRejected(state, r);
    for (const h of scanned.hashes) {
      addRejected(state, {
        raw: view.text.slice(h.span.start, h.span.end),
        reason: 'tx_hash_like',
        view: h.view,
        span: h.span,
      });
    }
  }

  // Second pass: same address elsewhere in the capture, then the page-level EVM chain prior.
  const firstPass = [...attributedByView.values()].flat();
  const pageChain = pageChainPrior(firstPass);
  for (const [state, list] of attributedByView) {
    attributedByView.set(state, applyPageChain(list, pageChain, firstPass));
  }

  // Page statistics and cross-view deduplication.
  const containerSets = new Map<string, Set<string>>();
  const occurrences: Occurrence<AttributedCandidate>[] = [];
  for (const [state, list] of attributedByView) {
    for (const c of list) {
      const container = segmentAt(state.view, c.span.start)?.container ?? 0;
      const key = containerKey(state.view, container);
      containerSets.set(key, (containerSets.get(key) ?? new Set()).add(c.canonical));
      occurrences.push({
        item: c,
        state,
        key: `${c.family}:${c.canonical}`,
        span: c.span,
        sources: sourcesOf(state, c.span),
        rank: (c.transforms.includes('gap_joined') ? 100 : 0) + viewRank(state.view.view),
      });
    }
  }
  const kept = dedupe(occurrences);
  const occurrenceCounts = new Map<string, number>();
  for (const o of kept) occurrenceCounts.set(o.item.canonical, (occurrenceCounts.get(o.item.canonical) ?? 0) + 1);
  const page: PageStats = {
    distinctAddresses: occurrenceCounts.size,
    occurrences: occurrenceCounts,
    containerAddressCounts: new Map([...containerSets].map(([k, set]) => [k, set.size])),
  };

  const scrubber = new SecretScrubber();
  const candidates: AddressCandidate[] = kept.map(({ item: c, state }) => {
    const secrets = state.secrets.map((s) => s.finding);
    return {
      id: newId(),
      captureId: content.captureId,
      raw: c.raw,
      address: { chain: c.chain, address: c.canonical },
      format: c.format,
      checksum: c.checksum,
      chainAttribution: c.chainAttribution,
      view: reportedView(state, c.span),
      span: c.span,
      transforms: c.transforms,
      context: buildContext(c, state.view, state.norm, secrets, page, scrubber),
      reviewRequired: c.reviewRequired,
    };
  });
  candidates.sort(
    (a, b) =>
      viewOrder(a.view) - viewOrder(b.view) ||
      a.span.start - b.span.start ||
      compareStrings(a.address.chain, b.address.chain),
  );

  const keptRejected = dedupe(rejected).map(({ item, state }) => ({
    raw: item.raw,
    reason: item.reason,
    view: reportedView(state, item.span),
    span: item.span,
  }));
  keptRejected.sort(
    (a, b) =>
      viewOrder(a.view) - viewOrder(b.view) || a.span.start - b.span.start || compareStrings(a.reason, b.reason),
  );
  if (keptRejected.length > maxRejected) {
    warnings.add(`rejected_truncated:${keptRejected.length - maxRejected}`);
    keptRejected.length = maxRejected;
  }

  const secretOccurrences: Occurrence<SecretFinding>[] = states.flatMap((state) =>
    state.secrets
      .filter((s) => !s.derived)
      .map((s) => ({
        item: s.finding,
        state,
        key: s.finding.kind,
        span: s.finding.span,
        sources: sourcesOf(state, s.finding.span),
        rank: viewRank(state.view.view),
      })),
  );
  const secrets: SecretFinding[] = dedupe(secretOccurrences).map(({ item, state }) => ({
    kind: item.kind,
    view: reportedView(state, item.span),
    span: item.span,
  }));
  secrets.sort((a, b) => viewOrder(a.view) - viewOrder(b.view) || a.span.start - b.span.start);

  for (const kind of scrubber.kinds) warnings.add(`context_secret_redacted:${kind}`);
  const result: ExtractCaptureResult = {
    captureId: content.captureId,
    candidates,
    rejected: keptRejected,
    secrets,
    extractorVersion: EXTRACTOR_VERSION,
    warnings: [...warnings].toSorted(),
  };
  assertNoSecretLeak(result, states, scrubber);
  return result;
}

/**
 * Extracts, validates and contextualises the crypto addresses of one capture. Pure: the bytes come in, nothing is
 * fetched, logged or stored. Asynchronous so image channels can be added without changing callers.
 */
export async function extractCapture(content: CaptureContent, options: ExtractOptions): Promise<ExtractCaptureResult> {
  return extract(content, options);
}
