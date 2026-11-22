/**
 * Benchmark runner: fills the secret placeholders in memory, runs `extractCapture` and the SpiderFoot baseline on
 * every corpus document, matches the results against the ground truth (address level per document and span level
 * via the views' source maps) and assembles the `BenchReport`. Offline and deterministic except for timings.
 */
import { chainFamily, type ChainAttributionMethod, type ChainId, type TextSpan, type TextView } from '@olcys/core';
import type { DenyList } from '../src/deny-list.ts';
import {
  EXTRACTOR_VERSION,
  extractCapture,
  SecretLeakError,
  type ExtractCaptureResult,
  type ExtractOptions,
} from '../src/extract.ts';
import type { CaptureContent, ViewText } from '../src/pipeline-types.ts';
import { buildViews } from '../src/views/build.ts';
import { SPIDERFOOT_VERSION, spiderfootScan } from './baselines/spiderfoot.ts';
import { loadCorpus, type CorpusDocument, type LoadedCorpus } from './corpus.ts';
import { Bootstrap, macroF1, ratio, Tally } from './metrics.ts';
import {
  countLeaks,
  countLeaksIn,
  fillSecrets,
  mergeFragments,
  secretFragments,
  type LeakFragments,
} from './secrets.ts';
import { evaluateGates } from './thresholds.ts';
import {
  CHANNELS,
  CORPUS_FAMILIES,
  NEGATIVE_KINDS,
  OBFUSCATIONS,
  SECRET_KINDS,
  type Accuracy,
  type BenchReport,
  type Channel,
  type Metrics,
  type NegativeKind,
  type TruthRow,
} from './types.ts';

export interface BenchOptions {
  denyList: DenyList;
  /** Extraction under test (default `extractCapture`; tests inject faulty extractors to check the scoring). */
  extract?: (content: CaptureContent, options: ExtractOptions) => Promise<ExtractCaptureResult>;
  corpusDir?: string;
  /** Already loaded corpus (tests). */
  corpus?: LoadedCorpus;
  resamples?: number;
  bootstrapSeed?: string;
  /** Progress lines; they are captured and included in the leak check. */
  log?: (line: string) => void;
  now?: () => Date;
}

export interface BenchRun {
  report: BenchReport;
  /** Fragments of every secret filled in this run (for leak checks of derived artefacts); never persist them. */
  secretFragments: LeakFragments;
}

interface Range {
  start: number;
  end: number;
}

export interface Prediction {
  /** Canonical key (EVM and bech32 lower-case). */
  key: string;
  chain: ChainId;
  family: string;
  format: string;
  source?: Range;
  method?: ChainAttributionMethod;
  role?: string;
  view?: TextView;
}

type PredictionClass = 'tp' | 'duplicate' | 'example' | 'unverifiable' | 'fp' | 'unlabelled';

interface Classified {
  p: Prediction;
  cls: PredictionClass;
  row?: TruthRow;
}

const TOLERANCE = 2;
const CORROBORATED = new Set<ChainAttributionMethod>([
  'uri_chain_id',
  'caip10',
  'eip3770',
  'explorer_domain',
  'keyword',
]);
const UNCHECKSUMMED = new Set(['evm_lower', 'evm_upper']);
/** Chains both tools detect (the comparison slice). */
const COMPARISON_FAMILIES = new Set(['bitcoin', 'evm']);
const IMAGE_TAGS = new Set(['qr', 'ocr']);

export const canonicalKey = (value: string): string => (/^(?:0x|bc1)/i.test(value) ? value.toLowerCase() : value);

function formatFamily(format: string, chain: ChainId): string {
  if (format.startsWith('evm_') || format === 'spiderfoot_eth') return 'evm';
  if (format.startsWith('tron')) return 'tron';
  if (format.startsWith('p2') || format.startsWith('segwit_') || format === 'spiderfoot_btc') return 'bitcoin';
  return chainFamily(chain);
}

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end + TOLERANCE && b.start < a.end + TOLERANCE;
}

/** Exact source range of a view span (per-character source map), as the extractor computes it. */
function sourceOf(views: ReadonlyMap<TextView, ViewText>, view: TextView, span: TextSpan): Range | undefined {
  const v = views.get(view === 'code' ? 'visible_text' : view);
  const map = v?.sourceMap;
  if (!map) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = -1;
  for (let i = span.start; i < Math.max(span.end, span.start + 1) && i < map.length; i += 1) {
    const offset = map[i] ?? -1;
    if (offset < 0) continue;
    min = Math.min(min, offset);
    max = Math.max(max, offset);
  }
  return max >= 0 ? { start: min, end: max + 1 } : undefined;
}

/**
 * Span-level classification of one tool's predictions against the labelled rows of a document. `wrongChain` holds
 * predictions that found a positive's span and address but with a chain the bytes are not valid on (not a TP).
 */
function classify(
  predictions: readonly Prediction[],
  rows: readonly TruthRow[],
): { list: Classified[]; matched: Map<number, Prediction>; wrongChain: Map<number, Prediction> } {
  const matched = new Map<number, Prediction>();
  const wrongChain = new Map<number, Prediction>();
  const labelled = rows.filter((r) => !r.isSecret && r.source);
  const positiveKeys = new Set(
    rows.filter((r) => r.expected === 'positive' && r.canonical).map((r) => canonicalKey(r.canonical ?? '')),
  );
  const list: Classified[] = [];
  for (const p of predictions) {
    const over = p.source ? labelled.filter((r) => r.source && overlaps(p.source as Range, r.source)) : [];
    const same = (r: TruthRow): boolean => r.canonical !== undefined && canonicalKey(r.canonical) === p.key;
    const positive = over.find((r) => r.expected === 'positive' && same(r) && r.chainSet.includes(p.chain));
    if (positive) {
      if (matched.has(positive.occurrence)) list.push({ p, cls: 'duplicate', row: positive });
      else {
        matched.set(positive.occurrence, p);
        list.push({ p, cls: 'tp', row: positive });
      }
      continue;
    }
    const example = over.find((r) => r.expected === 'example' && same(r));
    if (example) {
      list.push({ p, cls: 'example', row: example });
      continue;
    }
    const unverifiable = over.find((r) => r.expected === 'unverifiable' && same(r));
    if (unverifiable) {
      list.push({ p, cls: 'unverifiable', row: unverifiable });
      continue;
    }
    const misattributed = over.find((r) => r.expected === 'positive' && same(r));
    if (misattributed && !wrongChain.has(misattributed.occurrence)) wrongChain.set(misattributed.occurrence, p);
    const row = misattributed ?? over.find((r) => r.expected !== 'positive') ?? over[0];
    if (row) list.push({ p, cls: 'fp', row });
    else list.push({ p, cls: positiveKeys.has(p.key) ? 'unlabelled' : 'fp' });
  }
  return { list, matched, wrongChain };
}

function viewChannel(view: TextView | undefined): Channel {
  if (view === 'attribute' || view === 'meta') return 'attr';
  if (view === 'json_ld') return 'json_ld';
  return 'text';
}

interface DocEval {
  doc: CorpusDocument;
  rows: TruthRow[];
  ours: Classified[];
  oursMatched: Map<number, Prediction>;
  oursWrongChain: Map<number, Prediction>;
  spiderfoot: Classified[];
  spiderfootMatched: Map<number, Prediction>;
  rejected: { reason: string; source?: Range }[];
  /** Start offsets (filled text) of secrets whose every character of key material is inside a finding. */
  redactedSecrets: Set<number>;
  bytes: number;
  error?: string;
}

function evaluateDocument(
  doc: CorpusDocument,
  result: ExtractCaptureResult | undefined,
  content: CaptureContent,
  filled: ReturnType<typeof fillSecrets>,
  error?: string,
): DocEval {
  const rows = doc.truth.map((r) => {
    if (!r.source) return r;
    const start = filled.mapOffset(r.source.start);
    const end = r.isSecret
      ? start + (filled.secrets.find((s) => s.start === start)?.value.length ?? r.source.end - r.source.start)
      : filled.mapOffset(r.source.end);
    return Object.assign({}, r, { source: { start, end } });
  });
  const views = new Map<TextView, ViewText>();
  for (const v of buildViews(content)) if (!views.has(v.view)) views.set(v.view, v);
  const ours: Prediction[] = (result?.candidates ?? []).map((c) => ({
    key: canonicalKey(c.address.address),
    chain: c.address.chain,
    family: formatFamily(c.format, c.address.chain),
    format: c.format,
    source: sourceOf(views, c.view, c.span),
    method: c.chainAttribution.method,
    role: c.context.roleCues[0] ?? 'unclear',
    view: c.view,
  }));
  const sf: Prediction[] = spiderfootScan(filled.text).map((m) => ({
    key: canonicalKey(m.value),
    chain: m.chain,
    family: m.chain === 'bitcoin' ? 'bitcoin' : 'evm',
    format: m.chain === 'bitcoin' ? 'spiderfoot_btc' : 'spiderfoot_eth',
    source: { start: m.start, end: m.end },
  }));
  const a = classify(ours, rows);
  const b = classify(sf, rows);
  const rejected = (result?.rejected ?? []).map((r) => ({ reason: r.reason, source: sourceOf(views, r.view, r.span) }));
  const findings = (result?.secrets ?? [])
    .map((s) => sourceOf(views, s.view, s.span))
    .filter((s): s is Range => s !== undefined);
  const redactedSecrets = new Set<number>();
  for (const secret of filled.secrets) {
    // Key material: every character, except the separators and list numbers between the words of a seed phrase.
    const material = [...secret.value].flatMap((c, i) =>
      secret.kind !== 'seed_phrase' || /\p{L}/u.test(c) ? [secret.start + i] : [],
    );
    if (material.every((at) => findings.some((f) => f.start <= at && at < f.end))) redactedSecrets.add(secret.start);
  }
  return {
    doc,
    rows,
    ours: a.list,
    oursMatched: a.matched,
    oursWrongChain: a.wrongChain,
    spiderfoot: b.list,
    spiderfootMatched: b.matched,
    rejected,
    redactedSecrets,
    bytes: content.artifacts[0]?.bytes.length ?? 0,
    ...(error ? { error } : {}),
  };
}

const MEDIA_TYPES: Record<string, { kind: 'html' | 'text' | 'json'; mediaType: string }> = {
  html: { kind: 'html', mediaType: 'text/html; charset=utf-8' },
  txt: { kind: 'text', mediaType: 'text/plain; charset=utf-8' },
  json: { kind: 'json', mediaType: 'application/json' },
};

function captureOf(doc: CorpusDocument, text: string, index: number): CaptureContent {
  const media = MEDIA_TYPES[doc.type] ?? { kind: 'text', mediaType: 'text/plain; charset=utf-8' };
  return {
    captureId: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    url: `https://example.org/corpus/${doc.docId}`,
    finalUrl: `https://example.org/corpus/${doc.docId}`,
    artifacts: [{ kind: media.kind, mediaType: media.mediaType, bytes: new TextEncoder().encode(text) }],
  };
}

class Tallies {
  readonly #map = new Map<string, Tally>();
  get(key: string): Tally {
    const t = this.#map.get(key) ?? new Tally();
    this.#map.set(key, t);
    return t;
  }
  keys(): string[] {
    return [...this.#map.keys()];
  }
}

/** Address-level counts of one document for one tool (distinct canonical addresses). */
function addressLevel(
  e: DocEval,
  list: readonly Classified[],
  sink: (kind: 'tp' | 'fp' | 'fn', family: string, subtype: string) => void,
  families?: ReadonlySet<string>,
): void {
  const truth = new Map<string, TruthRow>();
  for (const r of e.rows) {
    if (r.expected !== 'positive' || !r.canonical) continue;
    const family = formatFamily(r.subtype ?? '', r.chain ?? 'bitcoin');
    if (families && !families.has(family)) continue;
    if (!truth.has(canonicalKey(r.canonical))) truth.set(canonicalKey(r.canonical), r);
  }
  const predicted = new Map<string, Prediction[]>();
  for (const c of list) {
    if (c.cls === 'example' || c.cls === 'unverifiable') continue;
    if (families && !families.has(c.p.family)) continue;
    predicted.set(c.p.key, [...(predicted.get(c.p.key) ?? []), c.p]);
  }
  // A TP needs the address with a chain its bytes are valid on; the same address on an impossible chain is FN + FP.
  const valid = (row: TruthRow | undefined, preds: readonly Prediction[]): boolean =>
    row !== undefined && preds.some((p) => row.chainSet.includes(p.chain));
  for (const [key, row] of truth) {
    const ok = valid(row, predicted.get(key) ?? []);
    sink(ok ? 'tp' : 'fn', formatFamily(row.subtype ?? '', row.chain ?? 'bitcoin'), row.subtype ?? '');
  }
  for (const [key, preds] of predicted) {
    const first = preds[0];
    if (first && !valid(truth.get(key), preds)) sink('fp', first.family, first.format);
  }
}

function accuracy(pairs: readonly boolean[]): Accuracy {
  const correct = pairs.filter(Boolean).length;
  return { total: pairs.length, correct, accuracy: ratio(correct, pairs.length) };
}

export async function runBenchmark(options: BenchOptions): Promise<BenchRun> {
  const corpus = options.corpus ?? (await loadCorpus(options.corpusDir));
  const seed = corpus.manifest.seed;
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
    options.log?.(line);
  };
  const evals: DocEval[] = [];
  const fragments = { raw: new Set<string>(), words: new Set<string>() };
  let extractionMs = 0;
  let bytes = 0;
  let leaks = 0;
  // Console output during extraction is captured (not echoed: it could carry a secret) and leak-checked.
  const captured: string[] = [];
  const originalConsole = { ...console };
  const capture = (...args: unknown[]): void => {
    captured.push(args.map(String).join(' '));
  };

  log(`bench: ${corpus.documents.length} documents, corpus ${corpus.manifest.corpusVersion}, ${EXTRACTOR_VERSION}`);
  for (const [index, doc] of corpus.documents.entries()) {
    const filled = fillSecrets(doc.text, doc.docId, doc.type, seed);
    const docFragments = secretFragments(filled.secrets.map((s) => s.value));
    mergeFragments(fragments, docFragments);
    const content = captureOf(doc, filled.text, index);
    let result: ExtractCaptureResult | undefined;
    let error: string | undefined;
    let n = 0;
    const started = performance.now();
    Object.assign(console, { log: capture, info: capture, warn: capture, error: capture, debug: capture });
    try {
      // oxlint-disable-next-line no-await-in-loop
      result = await (options.extract ?? extractCapture)(content, {
        denyList: options.denyList,
        newId: () => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`,
      });
    } catch (caught) {
      if (!(caught instanceof SecretLeakError)) throw caught;
      error = caught.message;
      leaks += 1;
    } finally {
      Object.assign(console, originalConsole);
    }
    extractionMs += performance.now() - started;
    bytes += content.artifacts[0]?.bytes.length ?? 0;
    if (result) leaks += countLeaksIn(result, docFragments);
    evals.push(evaluateDocument(doc, result, content, filled, error));
    if ((index + 1) % 100 === 0) log(`bench: ${index + 1}/${corpus.documents.length} documents`);
  }
  leaks += countLeaks([...logs, ...captured].join('\n'), fragments);
  if (captured.length > 0) log(`bench: ${captured.length} console line(s) written during extraction (leak-checked)`);

  const report = assemble(corpus, evals, {
    extractionMs,
    bytes,
    leaks,
    resamples: options.resamples ?? 1000,
    bootstrapSeed: options.bootstrapSeed ?? 'olcys-bench-bootstrap-v1',
    now: options.now ?? (() => new Date()),
  });
  return { report, secretFragments: fragments };
}

function assemble(
  corpus: LoadedCorpus,
  evals: readonly DocEval[],
  run: {
    extractionMs: number;
    bytes: number;
    leaks: number;
    resamples: number;
    bootstrapSeed: string;
    now: () => Date;
  },
): BenchReport {
  const boot = new Bootstrap(evals.length, run.resamples, run.bootstrapSeed);
  const overall = new Tally();
  const byChain = new Tallies();
  const bySubtype = new Tallies();
  const byObfuscation = new Tallies();
  const byChannel = new Tallies();
  const clean = new Tallies();
  const obfuscated = new Tally();
  const corroborated = new Tally();
  const sfOverall = new Tally();
  const sfByChain = new Tallies();
  const hardOurs = new Tally();
  const hardSf = new Tally();
  const cmpOurs = new Tally();
  const cmpSf = new Tally();
  const attributionPairs = new Map<string, boolean[]>();
  const rolePairs: { truth: string; predicted: string }[] = [];
  const negatives: BenchReport['negatives'] = {};
  const secretsByKind: Record<string, { total: number; redacted: number }> = {};
  const failures: BenchReport['failures'] = {
    falseNegatives: [],
    falsePositives: [],
    attributionErrors: [],
    gateFailures: [],
  };
  let hardDocs = 0;
  const pushAttribution = (slice: string, ok: boolean): void => {
    attributionPairs.set(slice, [...(attributionPairs.get(slice) ?? []), ok]);
  };

  for (const [d, e] of evals.entries()) {
    // Address level (overall, chain, subtype; SpiderFoot; comparison slices).
    addressLevel(e, e.ours, (kind, family, subtype) => {
      overall.add(d, kind);
      byChain.get(family).add(d, kind);
      bySubtype.get(subtype).add(d, kind);
    });
    addressLevel(e, e.spiderfoot, (kind, family) => {
      sfOverall.add(d, kind);
      sfByChain.get(family).add(d, kind);
    });
    addressLevel(e, e.ours, (kind) => cmpOurs.add(d, kind), COMPARISON_FAMILIES);
    addressLevel(e, e.spiderfoot, (kind) => cmpSf.add(d, kind), COMPARISON_FAMILIES);
    const hasHardNegatives = e.rows.some((r) => r.expected === 'reject' || r.expected === 'testnet');
    if (hasHardNegatives) {
      hardDocs += 1;
      addressLevel(e, e.ours, (kind) => hardOurs.add(d, kind), COMPARISON_FAMILIES);
      addressLevel(e, e.spiderfoot, (kind) => hardSf.add(d, kind), COMPARISON_FAMILIES);
    }

    // Span level: positives.
    for (const r of e.rows) {
      if (r.expected !== 'positive') continue;
      const hit = e.oursMatched.get(r.occurrence);
      const kind = hit ? 'tp' : 'fn';
      for (const tag of r.obfuscation.length > 0 ? r.obfuscation : ['none']) byObfuscation.get(tag).add(d, kind);
      byChannel.get(r.channel).add(d, kind);
      const family = formatFamily(r.subtype ?? '', r.chain ?? 'bitcoin');
      if (r.obfuscation.length === 0 && r.hasChecksum) clean.get(family).add(d, kind);
      if (r.obfuscation.length > 0) obfuscated.add(d, kind);
      if (!hit) {
        const wrong = e.oursWrongChain.get(r.occurrence);
        if (wrong) {
          pushAttribution('all', false);
          failures.attributionErrors.push({
            docId: e.doc.docId,
            occurrence: r.occurrence,
            expected: r.chain ?? r.chainSet.join('|'),
            actual: wrong.chain,
            method: wrong.method ?? '',
          });
        }
        failures.falseNegatives.push({
          docId: e.doc.docId,
          occurrence: r.occurrence,
          ...(r.ref ? { ref: r.ref } : {}),
          channel: r.channel,
          obfuscation: r.obfuscation,
        });
        continue;
      }
      if (r.chain) {
        const ok = hit.chain === r.chain;
        pushAttribution('all', ok);
        pushAttribution(family, ok);
        if (r.subtype === 'p2pkh' || r.subtype === 'p2sh') pushAttribution('base58_1_3', ok);
        if (r.subtype === 'p2sh') pushAttribution('p2sh_3', ok);
        if (r.channel === 'uri' || r.channel === 'explorer') pushAttribution(`marker_${r.channel}`, ok);
        if (!ok) {
          failures.attributionErrors.push({
            docId: e.doc.docId,
            occurrence: r.occurrence,
            expected: r.chain,
            actual: hit.chain,
            method: hit.method ?? '',
          });
        }
      }
      rolePairs.push({ truth: r.role === 'none' ? 'unclear' : r.role, predicted: hit.role ?? 'unclear' });
    }

    // Span level: false positives and corroborated unchecksummed predictions.
    for (const c of e.ours) {
      if (UNCHECKSUMMED.has(c.p.format) && c.p.method && CORROBORATED.has(c.p.method)) {
        if (c.cls === 'tp' || c.cls === 'unlabelled') corroborated.add(d, 'tp');
        else if (c.cls === 'fp') corroborated.add(d, 'fp');
      }
      if (c.cls !== 'fp') continue;
      const tags = c.row && c.row.obfuscation.length > 0 ? c.row.obfuscation : ['none'];
      for (const tag of tags) byObfuscation.get(tag).add(d, 'fp');
      byChannel.get(c.row?.channel ?? viewChannel(c.p.view)).add(d, 'fp');
      if (!UNCHECKSUMMED.has(c.p.format) && (!c.row || c.row.obfuscation.length === 0))
        clean.get(c.p.family).add(d, 'fp');
      failures.falsePositives.push({
        docId: e.doc.docId,
        address: c.p.key,
        format: c.p.format,
        reason: c.row ? `${c.row.expected}:${c.row.negativeKind ?? c.row.subtype ?? ''}` : 'unexpected',
      });
    }

    // Hard negatives: accepted by either tool, rejected with the expected reason.
    for (const r of e.rows) {
      if (r.expected === 'positive' || r.isSecret || !r.negativeKind) continue;
      const entry = (negatives[r.negativeKind] ??= {
        expected: r.expected,
        total: 0,
        accepted: 0,
        rejectedAsExpected: 0,
        spiderfootAccepted: 0,
        ...(r.rejectCode ? { rejectCode: r.rejectCode } : {}),
      });
      entry.total += 1;
      if (e.ours.some((c) => c.row === r)) entry.accepted += 1;
      if (e.spiderfoot.some((c) => c.row === r)) entry.spiderfootAccepted += 1;
      const code = r.rejectCode;
      if (code && r.source) {
        const source = r.source;
        if (e.rejected.some((x) => x.source && overlaps(x.source, source) && x.reason.split(':')[0] === code)) {
          entry.rejectedAsExpected += 1;
        }
      }
    }

    // Secrets.
    for (const r of e.rows) {
      if (!r.isSecret || !r.secretKind || !r.source) continue;
      const entry = (secretsByKind[r.secretKind] ??= { total: 0, redacted: 0 });
      entry.total += 1;
      if (!e.error && e.redactedSecrets.has(r.source.start)) entry.redacted += 1;
    }
  }

  const metricsOf = (tallies: Tallies, order?: readonly string[]): Record<string, Metrics> => {
    const keys = order
      ? [...order.filter((k) => tallies.keys().includes(k)), ...tallies.keys().filter((k) => !order.includes(k))]
      : tallies.keys().toSorted();
    return Object.fromEntries(keys.map((k) => [k, boot.metrics(tallies.get(k))]));
  };
  const obfuscationOrder = ['none', ...OBFUSCATIONS];
  const byObfuscationReport: BenchReport['byObfuscation'] = {};
  for (const tag of obfuscationOrder) {
    if (IMAGE_TAGS.has(tag)) byObfuscationReport[tag] = 'not_run';
    else if (byObfuscation.keys().includes(tag)) byObfuscationReport[tag] = boot.metrics(byObfuscation.get(tag));
  }
  const byChannelReport: BenchReport['byChannel'] = {};
  for (const channel of CHANNELS) {
    if (IMAGE_TAGS.has(channel)) byChannelReport[channel] = 'not_run';
    else if (byChannel.keys().includes(channel)) byChannelReport[channel] = boot.metrics(byChannel.get(channel));
  }
  const roles = macroF1(rolePairs);
  const secretTotal = Object.values(secretsByKind).reduce((n, s) => n + s.total, 0);
  const secretRedacted = Object.values(secretsByKind).reduce((n, s) => n + s.redacted, 0);
  const seconds = run.extractionMs / 1000;
  const attribution = Object.fromEntries([...attributionPairs].map(([k, v]) => [k, accuracy(v)]));
  const cleanMetrics = metricsOf(clean, CORPUS_FAMILIES);

  const report: BenchReport = {
    corpusVersion: corpus.manifest.corpusVersion,
    extractorVersion: EXTRACTOR_VERSION,
    generatedAt: run.now().toISOString(),
    overall: boot.metrics(overall),
    byChain: metricsOf(byChain, CORPUS_FAMILIES),
    bySubtype: metricsOf(bySubtype, Object.keys(corpus.manifest.counts.positivesBySubtype)),
    byObfuscation: byObfuscationReport,
    byChannel: byChannelReport,
    chainAttributionAccuracy: attribution['all']?.accuracy ?? Number.NaN,
    roleMacroF1: roles.macroF1,
    secrets: {
      total: secretTotal,
      redacted: secretRedacted,
      recall: ratio(secretRedacted, secretTotal),
      leaks: run.leaks,
      byKind: Object.fromEntries(
        SECRET_KINDS.filter((k) => secretsByKind[k]).map((k) => [k, secretsByKind[k] ?? { total: 0, redacted: 0 }]),
      ),
    },
    throughput: {
      docsPerSecond: ratio(evals.length, seconds),
      mbPerSecond: ratio(run.bytes / 1_000_000, seconds),
    },
    baselines: {
      spiderfoot: {
        version: SPIDERFOOT_VERSION,
        chains: ['bitcoin', 'evm'],
        overall: boot.metrics(sfOverall),
        byChain: metricsOf(sfByChain, CORPUS_FAMILIES),
      },
      iocsearcher: 'not_run',
    },
    corpus: {
      seed: corpus.manifest.seed,
      documents: evals.length,
      bytes: run.bytes,
      truthRows: evals.reduce((n, e) => n + e.rows.length, 0),
      positives: evals.reduce((n, e) => n + e.rows.filter((r) => r.expected === 'positive').length, 0),
      negatives: evals.reduce(
        (n, e) => n + e.rows.filter((r) => ['reject', 'testnet', 'example'].includes(r.expected)).length,
        0,
      ),
      unverifiable: evals.reduce((n, e) => n + e.rows.filter((r) => r.expected === 'unverifiable').length, 0),
      templates: corpus.manifest.counts.templates,
    },
    gates: [],
    gateMetrics: { cleanMetrics, obfuscated: boot.metrics(obfuscated), corroborated: boot.metrics(corroborated) },
    attribution,
    roles: { macroF1: roles.macroF1, byRole: roles.byClass },
    negatives: Object.fromEntries(
      Object.entries(negatives).toSorted(
        ([a], [b]) => NEGATIVE_KINDS.indexOf(a as NegativeKind) - NEGATIVE_KINDS.indexOf(b as NegativeKind),
      ),
    ),
    hardNegativeDocuments: { documents: hardDocs, ours: boot.metrics(hardOurs), spiderfoot: boot.metrics(hardSf) },
    comparisonChains: {
      chains: [...COMPARISON_FAMILIES],
      ours: boot.metrics(cmpOurs),
      spiderfoot: boot.metrics(cmpSf),
    },
    unsupported: corpus.manifest.unsupported,
    failures,
  };
  report.gates = evaluateGates(report, report.gateMetrics);
  failures.gateFailures = report.gates.filter((g) => !g.passed).map((g) => g.id);
  return report;
}
