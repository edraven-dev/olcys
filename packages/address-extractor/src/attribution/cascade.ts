/**
 * Chain-attribution cascade (first hit wins): explicit chain id (EIP-681 `@id`, CAIP-10, EIP-3770) → explorer domain
 * → keyword (±80 chars in the same container, or JSON key / attribute / structural label) → page prior → unknown.
 * Formats valid on one chain only short-circuit with `format_unique`.
 */
import { chainFamily, type ChainAttributionMethod, type ChainId } from '@olcys/core';
import { toNormalised } from '../normalise/normalise.ts';
import type {
  AttributedCandidate,
  NormalisedText,
  PaymentContext,
  RawCandidate,
  RejectedMatch,
  ValidatedCandidate,
  ViewText,
} from '../pipeline-types.ts';
import { foldText } from '../text/fold.ts';
import { blockOf, containerRange, segmentAt } from '../views/segments.ts';
import { findContextsInText } from './contexts.ts';

const KEYWORD_WINDOW = 80;
const word = (body: string): string => `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`;

interface KeywordRule {
  chain: ChainId;
  /** Case-insensitive terms, matched on folded (lower-case, no diacritics) text. */
  folded?: RegExp;
  /** Case-sensitive terms, matched on the normalised text. */
  exact?: RegExp;
}

const rule = (chain: ChainId, folded?: string, exact?: string): KeywordRule => ({
  chain,
  ...(folded ? { folded: new RegExp(word(folded), 'gu') } : {}),
  ...(exact ? { exact: new RegExp(word(exact), 'gu') } : {}),
});

const EVM_KEYWORDS: readonly KeywordRule[] = [
  rule('evm:1', 'ethereum|erc-?20|ether|mainnet', 'ETH'),
  rule('evm:56', 'bep-?20|bsc|bnb smart chain|binance smart chain|bnb chain', 'BNB'),
  rule('evm:137', 'polygon|matic', 'POL'),
  rule('evm:42161', 'arbitrum', 'ARB'),
  rule('evm:10', 'optimism|op mainnet'),
  rule('evm:8453', 'base mainnet|base network|siec base|sieci base', 'Base'),
  rule('evm:100', 'gnosis|xdai'),
  rule('evm:59144', 'linea'),
];
const UTXO_KEYWORDS: readonly KeywordRule[] = [
  rule('litecoin', 'litecoin', 'LTC'),
  rule('bitcoincash', 'bitcoin cash', 'BCH'),
  rule('bitcoin', 'bitcoin', 'BTC'),
];
const EXPLICIT_METHODS = new Set<ChainAttributionMethod>(['uri_chain_id', 'caip10', 'eip3770', 'explorer_domain']);

interface KeywordHit {
  chain: ChainId;
  start: number;
  end: number;
  word: string;
}

function keywordHits(raw: string, rules: readonly KeywordRule[], offset: number): KeywordHit[] {
  const folded = foldText(raw);
  const hits: KeywordHit[] = [];
  for (const r of rules) {
    for (const [regex, text] of [
      [r.folded, folded],
      [r.exact, raw],
    ] as const) {
      if (!regex) continue;
      for (const m of text.matchAll(regex)) {
        hits.push({
          chain: r.chain,
          start: offset + m.index,
          end: offset + m.index + m[0].length,
          word: raw.slice(m.index, m.index + m[0].length),
        });
      }
    }
  }
  // "mainnet" inside "op mainnet", "bitcoin" inside "bitcoin cash": the longer term wins.
  return hits.filter(
    (h) =>
      !hits.some(
        (o) => o.chain !== h.chain && o.start <= h.start && h.end <= o.end && o.end - o.start > h.end - h.start,
      ),
  );
}

function decamel(label: string): string {
  return label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[/_.~-]+/g, ' ');
}

type Step = { chain: ChainId; method: ChainAttributionMethod; detail?: string } | { conflict: string } | undefined;

function keywordStep(
  c: ValidatedCandidate,
  view: ViewText,
  norm: NormalisedText,
  rules: readonly KeywordRule[],
  contexts: readonly PaymentContext[],
): Step {
  const container = containerRange(view, c.span.start);
  const from = Math.max(toNormalised(norm, container.start), c.nStart - KEYWORD_WINDOW, 0);
  const to = Math.min(toNormalised(norm, container.end), c.nEnd + KEYWORD_WINDOW, norm.text.length);
  const hits = to > from ? keywordHits(norm.text.slice(from, to), rules, from) : [];
  const distance = (h: KeywordHit): number => (h.end <= c.nStart ? c.nStart - h.end : h.start - c.nEnd);
  // Words inside URIs and links are syntax (`ethereum:` serves every EVM chain), not chain keywords.
  const inMarker = (h: KeywordHit): boolean =>
    contexts.some((ctx) => h.start < ctx.range.nEnd && h.end > ctx.range.nStart);
  const near = hits.filter((h) => (h.end <= c.nStart || h.start >= c.nEnd) && !inMarker(h));
  if (near.length > 0) {
    const best = Math.min(...near.map(distance));
    const closest = near.filter((h) => distance(h) === best);
    const chains = [...new Set(closest.map((h) => h.chain))];
    if (chains.length > 1) return { conflict: `keyword_conflict:${chains.join('|')}` };
    const hit = closest[0];
    if (hit) return { chain: hit.chain, method: 'keyword', detail: hit.word };
  }
  const segment = segmentAt(view, c.span.start);
  const labels: [string | undefined, string | undefined][] = [
    [segment?.jsonPointer, 'json key'],
    [segment?.attribute?.startsWith('data-') ? segment.attribute : undefined, undefined],
    [blockOf(view, segment)?.structuralLabel, undefined],
  ];
  for (const [label, detail] of labels) {
    if (!label) continue;
    const labelHits = keywordHits(decamel(label), rules, 0);
    const chains = [...new Set(labelHits.map((h) => h.chain))];
    if (chains.length > 1) return { conflict: `keyword_conflict:${chains.join('|')}` };
    const hit = labelHits[0];
    if (hit) return { chain: hit.chain, method: 'keyword', detail: detail ?? hit.word };
  }
  return undefined;
}

function markerName(ctx: PaymentContext): string {
  return ctx.host ?? ctx.scheme ?? ctx.kind;
}

function explicitMethod(ctx: PaymentContext): ChainAttributionMethod {
  if (ctx.kind === 'caip10') return 'caip10';
  if (ctx.kind === 'eip3770') return 'eip3770';
  if (ctx.kind === 'explorer') return 'explorer_domain';
  return 'uri_chain_id';
}

function isEvm(chain: ChainId): boolean {
  return chainFamily(chain) === 'evm';
}

/** Contexts of the candidate's own `<a href>` whose target is the candidate's address. */
function hrefContexts(c: ValidatedCandidate, view: ViewText): PaymentContext[] {
  const href = segmentAt(view, c.span.start)?.href;
  if (!href || c.view === 'attribute') return [];
  return findContextsInText(href).filter(
    (ctx) => ctx.target && href.slice(ctx.target.nStart, ctx.target.nEnd).toLowerCase() === c.canonical.toLowerCase(),
  );
}

function attributeOne(
  c: ValidatedCandidate,
  contexts: readonly PaymentContext[],
  view: ViewText,
  norm: NormalisedText,
  pageChain: ChainId | undefined,
): AttributedCandidate | RejectedMatch {
  const own = [
    ...contexts.filter((ctx) => ctx.target && ctx.target.nStart <= c.nStart && c.nEnd <= ctx.target.nEnd),
    ...hrefContexts(c, view),
  ];
  if (own.some((ctx) => ctx.role === 'token_contract')) {
    return { raw: c.raw, reason: 'uri_token_contract', view: c.view, span: c.span, patternId: c.patternId };
  }
  const payment = own.find((ctx) => ctx.kind === 'uri' && ctx.role === 'recipient');
  const done = (chain: ChainId, method: ChainAttributionMethod, detail?: string): AttributedCandidate => ({
    ...c,
    chain,
    chainAttribution: { method, ...(detail ? { detail } : {}) },
    ...(payment ? { payment } : {}),
  });

  const evm = c.possibleChains.some(isEvm);
  const fits = (chain: ChainId): boolean =>
    evm ? isEvm(chain) && chain !== 'evm:unknown' : c.possibleChains.includes(chain);
  const mismatches = own
    .filter((ctx) => ctx.chainId && !fits(ctx.chainId))
    .map((ctx) => `marker_mismatch:${markerName(ctx)}`);
  const mismatchDetail = mismatches.length > 0 ? [...new Set(mismatches)].join(', ') : undefined;

  // Formats that exist on one chain only (bech32 `bc1`, TRON `T…`).
  if (!evm && c.possibleChains.length === 1) {
    return done(c.defaultChain, 'format_unique', mismatchDetail);
  }

  // 1–2: explicit chain id, then explorer domain.
  const explicit = own.filter((ctx) => ctx.chainId && fits(ctx.chainId));
  const ordered = [
    ...explicit.filter((ctx) => ctx.kind !== 'explorer'),
    ...explicit.filter((ctx) => ctx.kind === 'explorer'),
  ];
  const first = ordered[0];
  if (first?.chainId) {
    const method = explicitMethod(first);
    const detail =
      method === 'caip10' && first.scheme === 'eip155' ? `eip155:${first.chainId.slice(4)}` : markerName(first);
    return done(first.chainId, method, detail);
  }

  // 3: keyword.
  const rules = evm ? EVM_KEYWORDS : UTXO_KEYWORDS.filter((r) => c.possibleChains.includes(r.chain));
  const step = keywordStep(c, view, norm, rules, contexts);
  if (step && 'chain' in step) return done(step.chain, step.method, step.detail);
  const conflict = step && 'conflict' in step ? step.conflict : undefined;

  if (!evm) {
    const others = c.possibleChains.filter((chain) => chain !== c.defaultChain);
    const detail = [others.length > 0 ? `ambiguous: ${others.join('|')}` : undefined, conflict, mismatchDetail]
      .filter(Boolean)
      .join(', ');
    return done(c.defaultChain, 'format_unique', detail || undefined);
  }

  // 4: page prior, 5: unknown.
  if (pageChain && isEvm(pageChain)) return done(pageChain, 'page_chain', conflict ?? mismatchDetail);
  return done('evm:unknown', 'unknown', conflict ?? mismatchDetail);
}

/** Decides the chain of every validated candidate of one view. */
export function attributeChains(input: {
  candidates: ValidatedCandidate[];
  contexts: PaymentContext[];
  view: ViewText;
  norm: NormalisedText;
  pageChain?: ChainId;
}): { attributed: AttributedCandidate[]; added: RawCandidate[]; rejected: RejectedMatch[] } {
  const attributed: AttributedCandidate[] = [];
  const rejected: RejectedMatch[] = [];
  for (const c of input.candidates) {
    const result = attributeOne(c, input.contexts, input.view, input.norm, input.pageChain);
    if ('chain' in result) attributed.push(result);
    else rejected.push(result);
  }
  return { attributed, added: [], rejected };
}

/** Distinct addresses per attributed EVM chain, for one group of methods. */
function addressesByChain(
  all: readonly AttributedCandidate[],
  methods: (method: ChainAttributionMethod) => boolean,
): Map<ChainId, Set<string>> {
  const out = new Map<ChainId, Set<string>>();
  for (const c of all) {
    if (!isEvm(c.chain) || c.chain === 'evm:unknown' || !methods(c.chainAttribution.method)) continue;
    out.set(c.chain, (out.get(c.chain) ?? new Set()).add(c.canonical));
  }
  return out;
}

/**
 * Page-level EVM chain (second pass): ≥ 2 distinct addresses explicitly attributed to one chain with none
 * disagreeing, or ≥ 3 distinct addresses attributed by keyword to one chain and at least twice the runner-up.
 * Occurrences of one address in several views count once.
 */
export function pageChainPrior(all: readonly AttributedCandidate[]): ChainId | undefined {
  const explicit = addressesByChain(all, (m) => EXPLICIT_METHODS.has(m));
  const [onlyExplicit] = explicit.size === 1 ? [...explicit] : [];
  if (onlyExplicit && onlyExplicit[1].size >= 2) return onlyExplicit[0];
  const ranked = [...addressesByChain(all, (m) => m === 'keyword')]
    .map(([chain, set]) => [chain, set.size] as const)
    .toSorted((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  if (top && top[1] >= 3 && top[1] >= 2 * runnerUp) return top[0];
  return undefined;
}

/**
 * Second pass for EVM candidates still `unknown`: another occurrence of the same address in the capture (`reference`,
 * all views) with one attributed chain wins (`page_chain`, detail `same_address`), then the page prior (`page_chain`).
 */
export function applyPageChain(
  all: AttributedCandidate[],
  pageChain: ChainId | undefined,
  reference: readonly AttributedCandidate[] = all,
): AttributedCandidate[] {
  const known = addressesByChain(reference, (m) => m !== 'unknown' && m !== 'page_chain');
  const chainOf = new Map<string, ChainId | null>();
  for (const [chain, set] of known) {
    for (const address of set) chainOf.set(address, chainOf.has(address) ? null : chain);
  }
  return all.map((c) => {
    if (c.chainAttribution.method !== 'unknown' || !isEvm(c.chain)) return c;
    const same = chainOf.get(c.canonical);
    if (same) return { ...c, chain: same, chainAttribution: { method: 'page_chain', detail: 'same_address' } };
    if (!pageChain) return c;
    const detail = c.chainAttribution.detail;
    return { ...c, chain: pageChain, chainAttribution: { method: 'page_chain', ...(detail ? { detail } : {}) } };
  });
}
