/**
 * Scoring rules of the benchmark runner on a one-document corpus, with faulty extractors injected on purpose:
 * an impossible chain is FN + FP (and an attribution error), a partial redaction is not a redaction, a leaked
 * seed phrase is found even with other separators, and gates fail when the corpus lacks what they measure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedCorpus } from '../bench/corpus.ts';
import { runBenchmark } from '../bench/run.ts';
import { countLeaks, countLeaksIn, secretFragments } from '../bench/secrets.ts';
import type { CorpusManifest, TruthRow } from '../bench/types.ts';
import { parseDenyList } from '../src/deny-list.ts';
import { extractCapture, type ExtractCaptureResult } from '../src/extract.ts';
import type { CaptureContent } from '../src/pipeline-types.ts';
import { gen } from './helpers.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const denyList = parseDenyList(readFileSync(join(repoRoot, 'config/rules/deny-list.v1.yaml'), 'utf8'));
const placeholder = '{{SECRET:seed_phrase:1}}';

function tinyCorpus(): LoadedCorpus {
  const p2sh = gen.p2sh('bench-scoring');
  const text = `<html><body><div class="post"><p>Mój adres BTC: ${p2sh}</p></div><div class="post"><p>Fraza: ${placeholder}</p></div></body></html>`;
  const at = text.indexOf(p2sh);
  const secretAt = text.indexOf(placeholder);
  const base = { docId: 'pl-test-001', channel: 'text' as const, obfuscation: [], isSecret: false };
  const truth: TruthRow[] = [
    {
      ...base,
      occurrence: 0,
      source: { start: at, end: at + p2sh.length },
      canonical: p2sh,
      chainSet: ['bitcoin', 'litecoin', 'bitcoincash'],
      subtype: 'p2sh',
      isValid: true,
      hasChecksum: true,
      role: 'first_person_owner',
      expected: 'positive',
      chain: 'bitcoin',
      ref: 'btc-p2sh-test',
    },
    {
      ...base,
      occurrence: 1,
      source: { start: secretAt, end: secretAt + placeholder.length },
      chainSet: [],
      isValid: false,
      hasChecksum: false,
      role: 'none',
      isSecret: true,
      secretKind: 'seed_phrase',
      expected: 'secret',
      secretIndex: 1,
    },
  ];
  const manifest = {
    corpusVersion: 'test',
    seed: 'bench-scoring-seed',
    counts: { templates: { pl: 1 }, positivesBySubtype: { p2sh: 1 } },
    unsupported: [],
    files: {},
  } as unknown as CorpusManifest;
  return {
    dir: '',
    manifest,
    documents: [
      { docId: 'pl-test-001', lang: 'pl', template: 'test', type: 'html', path: 'docs/pl-test-001.html', text, truth },
    ],
  };
}

type Extract = (
  content: CaptureContent,
  options: Parameters<typeof extractCapture>[1],
) => Promise<ExtractCaptureResult>;

const run = (extract?: Extract) =>
  runBenchmark({ denyList, corpus: tinyCorpus(), resamples: 50, ...(extract ? { extract } : {}) }).then(
    (r) => r.report,
  );

describe('benchmark scoring rules', () => {
  it('scores the real extractor as one TP and one redacted secret', async () => {
    const report = await run();
    expect(report.overall).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(report.secrets).toMatchObject({ total: 1, redacted: 1, leaks: 0 });
    expect(report.attribution['all']).toMatchObject({ total: 1, correct: 1 });
  });

  it('counts an address on a chain its bytes are not valid on as FN + FP and as an attribution error', async () => {
    const report = await run(async (content, options) => {
      const result = await extractCapture(content, options);
      return {
        ...result,
        candidates: result.candidates.map((c) => Object.assign({}, c, { address: { ...c.address, chain: 'tron' } })),
      };
    });
    expect(report.overall).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(report.failures.attributionErrors).toEqual([
      expect.objectContaining({ docId: 'pl-test-001', expected: 'bitcoin', actual: 'tron' }),
    ]);
    expect(report.attribution['all']).toMatchObject({ total: 1, correct: 0 });
    expect(report.attribution['bitcoin']).toMatchObject({ total: 1, correct: 0 });
    expect(report.attribution['base58_1_3']).toMatchObject({ total: 1, correct: 0 });
    expect(report.attribution['p2sh_3']).toMatchObject({ total: 1, correct: 0 });
  });

  it('does not count a partial redaction as redacted', async () => {
    const report = await run(async (content, options) => {
      const result = await extractCapture(content, options);
      const secrets = result.secrets.map((s) =>
        Object.assign({}, s, { span: { start: s.span.start, end: s.span.start + 20 } }),
      );
      return { ...result, secrets };
    });
    expect(report.secrets).toMatchObject({ total: 1, redacted: 0 });
    expect(report.gates.find((g) => g.id === 'secret_recall')?.passed).toBe(false);
  });

  it('finds a leaked seed phrase even after its separators changed', async () => {
    const report = await run(async (content, options) => {
      const result = await extractCapture(content, options);
      const text = new TextDecoder().decode(content.artifacts[0]?.bytes);
      const phrase = text.slice(text.indexOf('Fraza: ') + 7, text.indexOf('</p>', text.indexOf('Fraza: ')));
      const leaked = phrase
        .split(/[\s,.\d]+/)
        .filter(Boolean)
        .join('\n');
      return { ...result, warnings: [...result.warnings, leaked] };
    });
    expect(report.secrets.leaks).toBeGreaterThan(0);
    expect(report.gates.find((g) => g.id === 'secret_leaks')?.passed).toBe(false);
  });

  it('does not count a result that only points into the occurrence as a span-level hit', async () => {
    const report = await run(async (content, options) => {
      const result = await extractCapture(content, options);
      const candidates = result.candidates.map((c) =>
        Object.assign({}, c, { span: { start: c.span.start, end: c.span.start + 1 } }),
      );
      return { ...result, candidates };
    });
    expect(report.overall).toMatchObject({ tp: 1, fn: 0 });
    expect(report.gateMetrics.cleanMetrics['bitcoin']).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(report.byChannel['text']).toMatchObject({ tp: 0, fn: 1 });
    expect(report.gates.find((g) => g.id === 'clean_recall:bitcoin')?.passed).toBe(false);
    expect(report.failures.falsePositives).toEqual([expect.objectContaining({ reason: 'misplaced:p2sh' })]);
  });

  it('finds a secret logged inside nested objects, maps and error causes', async () => {
    const report = await run(async (content, options) => {
      const result = await extractCapture(content, options);
      const text = new TextDecoder().decode(content.artifacts[0]?.bytes);
      const from = text.indexOf('Fraza: ') + 7;
      const phrase = text.slice(from, text.indexOf('</p>', from));
      console.info({ context: { snippet: phrase } });
      console.warn(new Map([['found', [new Error('boom', { cause: { phrase } })]]]));
      return result;
    });
    expect(report.secrets.leaks).toBeGreaterThan(0);
    expect(report.gates.find((g) => g.id === 'secret_leaks')?.passed).toBe(false);
  });

  it('fails the gates whose data is missing from the corpus instead of dropping them', async () => {
    const report = await run();
    const byId = new Map(report.gates.map((g) => [g.id, g]));
    expect(byId.get('clean_recall:bitcoin')?.passed).toBe(true);
    expect(byId.get('clean_recall:evm')?.passed).toBe(false);
    expect(byId.get('clean_precision:tron')?.passed).toBe(false);
    expect(byId.get('hash_like_candidates')?.passed).toBe(false);
    expect(byId.get('bech32_variant_mismatch')?.passed).toBe(false);
  });
});

describe('leak fragments', () => {
  it('matches a phrase across newlines, numbering, commas and JSON escapes', () => {
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const fragments = secretFragments([phrase]);
    const numbered = phrase
      .split(' ')
      .map((w, i) => `${i + 1}. ${w}`)
      .join(' ');
    expect(countLeaks(phrase.replaceAll(' ', '\n'), fragments)).toBeGreaterThan(0);
    expect(countLeaks(numbered, fragments)).toBeGreaterThan(0);
    expect(countLeaks(phrase.replaceAll(' ', ', '), fragments)).toBeGreaterThan(0);
    expect(countLeaksIn({ nested: [{ snippet: phrase.replaceAll(' ', '\n') }] }, fragments)).toBeGreaterThan(0);
    expect(countLeaks('Mój adres BTC: 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', fragments)).toBe(0);
  });
});
