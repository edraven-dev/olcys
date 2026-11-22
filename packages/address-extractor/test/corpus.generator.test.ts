import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CORPUS_DIR, loadCorpus, verifyManifest } from '../bench/corpus.ts';
import { decodeBase58check } from '../src/codecs.ts';
import { corpusDrift } from '../scripts/corpus/generate.ts';
import { POSITIVE_COUNTS } from '../scripts/corpus/lib/addresses.ts';
import { isAcceptedAddress } from '../scripts/corpus/lib/codecs.ts';
import { generateCorpus } from '../scripts/corpus/lib/corpus.ts';
import type { AddressRecord, NegativeRecord } from '../bench/types.ts';

const dir = DEFAULT_CORPUS_DIR;
const jsonl = <T>(path: string): T[] =>
  readFileSync(join(dir, path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((p) => join(root, p))
    .filter((p) => statSync(p).isFile());
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const WIF_LIKE = new RegExp(`(?<!${BASE58})[5KLc9]${BASE58}{50,51}(?!${BASE58})`, 'g');
const XPRV_LIKE = new RegExp(`[xtyzuvYZUV]prv${BASE58}{100,}`);
const HEX_KEY_NEAR_CONTEXT =
  /(?:klucz\w*\s+prywatn|prywatn\w*\s+klucz|private[\s_-]?key|privkey|secret|sekret|mnemonic|seed)[\s\S]{0,100}?(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/i;
const BIP39 = new Set(english);

/** Longest run of consecutive BIP-39 words separated only by spaces, punctuation or list numbers. */
function longestWordRun(text: string): number {
  let best = 0;
  let run = 0;
  let lastEnd = -1;
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    const word = m[0].toLowerCase();
    const gap = lastEnd < 0 ? '' : text.slice(lastEnd, m.index);
    const linked = lastEnd >= 0 && /^[\s,;.:|)(\d-]{1,12}$/.test(gap);
    run = BIP39.has(word) ? (linked ? run + 1 : 1) : 0;
    best = Math.max(best, run);
    lastEnd = m.index + m[0].length;
  }
  return best;
}

/** What a reader sees of an obfuscated occurrence once markup, encodings and invisible characters are removed. */
function deobfuscate(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/[\s\p{Cf}]/gu, '')
    .normalize('NFKC');
}

describe('synthetic extraction corpus', () => {
  it('regenerates byte for byte from the committed seed (corpus:check)', async () => {
    expect(await corpusDrift(dir)).toEqual([]);
  });

  it('matches the manifest hashes and stays well under the size cap', async () => {
    expect(await verifyManifest(dir)).toEqual([]);
    const size = files(dir).reduce((n, f) => n + statSync(f).size, 0);
    expect(size).toBeLessThan(15 * 1024 * 1024);
  });

  it('is deterministic per seed and depends on it', async () => {
    const a = await generateCorpus({ corpusDir: dir, seed: 'another-seed' });
    const b = await generateCorpus({ corpusDir: dir, seed: 'another-seed' });
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    expect(a.files.get('addresses/bitcoin.jsonl')).not.toBe(readFileSync(join(dir, 'addresses/bitcoin.jsonl'), 'utf8'));
  });

  it('holds the planned positives per chain and subtype, all valid, a quarter of bech32 in upper case', async () => {
    const { manifest } = await loadCorpus(dir);
    expect(manifest.counts.positivesBySubtype).toEqual(POSITIVE_COUNTS);
    expect(manifest.counts.positives).toEqual({ bitcoin: 500, evm: 400, tron: 300 });
    const records = ['bitcoin', 'evm', 'tron'].flatMap((c) => jsonl<AddressRecord>(`addresses/${c}.jsonl`));
    expect(records).toHaveLength(1200);
    for (const r of records) {
      expect(isAcceptedAddress(r.display)).toBe(true);
      expect(/^(?:0x|bc1)/i.test(r.display) ? r.display.toLowerCase() : r.display).toBe(r.canonical);
    }
    expect(records.filter((r) => r.display.startsWith('BC1'))).toHaveLength(75);
    expect(manifest.unsupported.map((u) => u.family)).toContain('solana');
  });

  it('has at least as many hard negatives as positives, none of them a valid address', () => {
    const negatives = jsonl<NegativeRecord>('negatives/hard-negatives.jsonl');
    const hard = negatives.filter(
      (n) => n.expected === 'reject' || n.expected === 'testnet' || n.expected === 'example',
    );
    expect(hard.length).toBeGreaterThanOrEqual(1200);
    const accepted = negatives.filter(
      (n) => n.expected === 'reject' && n.kind !== 'uri_token_contract' && isAcceptedAddress(n.value),
    );
    expect(accepted.map((n) => n.id)).toEqual([]);
    expect(negatives.filter((n) => n.kind === 'v1_in_bech32' || n.kind === 'v0_in_bech32m').length).toBeGreaterThan(0);
  });

  it('ships at least 30 templates, at least 20 of them Polish', async () => {
    const { manifest } = await loadCorpus(dir);
    expect((manifest.counts.templates['pl'] ?? 0) + (manifest.counts.templates['en'] ?? 0)).toBeGreaterThanOrEqual(30);
    expect(manifest.counts.templates['pl'] ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('labels occurrences whose source ranges point at the address and secret placeholders', async () => {
    const { documents } = await loadCorpus(dir);
    const display = new Map(
      ['bitcoin', 'evm', 'tron']
        .flatMap((c) => jsonl<AddressRecord>(`addresses/${c}.jsonl`))
        .map((r) => [r.id, r.display]),
    );
    const rows = documents.flatMap((doc) =>
      doc.truth.map((row) => ({
        id: `${doc.docId}#${row.occurrence}`,
        row,
        text: doc.text.slice(row.source?.start, row.source?.end),
      })),
    );
    const secrets = rows.filter((r) => r.row.isSecret);
    const positives = rows.filter((r) => r.row.expected === 'positive');
    const badSecrets = secrets.filter((r) => r.text !== `{{SECRET:${r.row.secretKind}:${r.row.secretIndex}}}`);
    const badPositives = positives.filter((r) => deobfuscate(r.text) !== display.get(r.row.ref ?? ''));
    expect(badSecrets.map((r) => r.id)).toEqual([]);
    expect(badPositives.map((r) => r.id)).toEqual([]);
    expect(positives.length).toBeGreaterThanOrEqual(1200);
    expect(secrets.length).toBeGreaterThanOrEqual(200);
  });

  it('never stores a private key, extended private key, seed phrase or hex key on disk', () => {
    const findings: string[] = [];
    for (const file of files(dir)) {
      const text = readFileSync(file, 'utf8');
      const name = relative(dir, file);
      for (const m of text.matchAll(WIF_LIKE)) {
        const payload = decodeBase58check(m[0]);
        if (payload && (payload.length === 33 || payload.length === 34) && [0x80, 0xef].includes(payload[0] ?? -1)) {
          findings.push(`${name}: WIF`);
        }
      }
      if (XPRV_LIKE.test(text)) findings.push(`${name}: xprv`);
      if (longestWordRun(text) >= 12) findings.push(`${name}: BIP-39 word run`);
      if (HEX_KEY_NEAR_CONTEXT.test(text)) findings.push(`${name}: hex key near key vocabulary`);
    }
    expect(findings).toEqual([]);
  });
});
