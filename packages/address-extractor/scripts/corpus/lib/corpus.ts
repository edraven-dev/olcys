/**
 * Deterministic corpus generation: positives → hard negatives → documents rendered from the templates → ground
 * truth → manifest. Same seed and generator version ⇒ byte-identical files. Pure apart from reading the templates.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prng } from '../../../bench/prng.ts';
import {
  ADDRESS_SUBTYPES,
  CHANNELS,
  CORPUS_FAMILIES,
  CORPUS_SCHEMA,
  NEGATIVE_EXPECTATIONS,
  NEGATIVE_KINDS,
  OBFUSCATIONS,
  SECRET_KINDS,
  type AddressRecord,
  type CorpusManifest,
  type NegativeRecord,
  type TruthRow,
} from '../../../bench/types.ts';
import { generateAddresses, isBech32Subtype } from './addresses.ts';
import { generateNegatives } from './negatives.ts';
import { Pools, renderDocument } from './render.ts';
import { parseTemplate, type TemplateDef } from './template.ts';

export const CORPUS_VERSION = '1.0.0';
export const GENERATOR_VERSION = 'corpus-generator.v1';
export const DEFAULT_SEED = 'olcys-extraction-corpus-v1';

/** Corpus design entries for chain families the extractor does not detect yet: not generated, not measured. */
export const UNSUPPORTED: CorpusManifest['unsupported'] = [
  { family: 'litecoin', formats: 'L…, M…, ltc1… (legacy 3… is measured with bitcoin p2sh)', planned: 300 },
  { family: 'dogecoin', formats: 'D…, A…, 9…', planned: 300 },
  {
    family: 'bitcoincash',
    formats: 'CashAddr with/without prefix (legacy 1…/3… is measured with bitcoin)',
    planned: 300,
  },
  { family: 'xrp', formats: 'classic r…, X-address', planned: 300 },
  { family: 'solana', formats: 'base58 public keys on and off the curve', planned: 300 },
  { family: 'monero', formats: 'standard, subaddress, integrated', planned: 300 },
  { family: 'cardano', formats: 'Shelley addr1…, Byron', planned: 300 },
  { family: 'ton', formats: 'EQ…/UQ… user-friendly, raw 0:…', planned: 300 },
  { family: 'lightning', formats: 'BOLT11, LNURL, LUD-16', planned: 200 },
  { family: 'xpub', formats: 'xpub, ypub, zpub', planned: 100 },
];

/** Generated paths (everything except the templates and the README). */
export const GENERATED_DIRS = ['addresses', 'negatives', 'docs'] as const;
export const GENERATED_FILES = ['ground-truth.jsonl', 'manifest.json'] as const;

export interface GeneratedCorpus {
  /** Generated files keyed by path below the corpus directory. */
  files: Map<string, string>;
  manifest: CorpusManifest;
  templates: TemplateDef[];
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const jsonl = (rows: readonly unknown[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string | undefined,
  order: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of order) out[k] = 0;
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) out[k] = (out[k] ?? 0) + 1;
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

export async function loadTemplates(
  corpusDir: string,
): Promise<{ templates: TemplateDef[]; sources: Map<string, string> }> {
  const templates: TemplateDef[] = [];
  const sources = new Map<string, string>();
  for (const lang of ['pl', 'en']) {
    const dir = join(corpusDir, 'templates', lang);
    // oxlint-disable-next-line no-await-in-loop
    const names = (await readdir(dir)).filter((n) => /\.(html|txt|json)$/.test(n)).toSorted();
    for (const name of names) {
      const path = `templates/${lang}/${name}`;
      // oxlint-disable-next-line no-await-in-loop
      const source = await readFile(join(dir, name), 'utf8');
      sources.set(path, source);
      templates.push(parseTemplate(path, source));
    }
  }
  return { templates, sources };
}

export async function generateCorpus(options: {
  corpusDir: string;
  seed?: string;
  /** `false` returns a corpus even when pools are left over (tuning templates). */
  strict?: boolean;
}): Promise<GeneratedCorpus> {
  const seed = options.seed ?? DEFAULT_SEED;
  const prng = new Prng(seed);
  const { templates, sources } = await loadTemplates(options.corpusDir);
  const addresses = generateAddresses(prng.fork('addresses'));
  const negatives = generateNegatives(prng.fork('negatives'), addresses);
  const pools = new Pools(prng.fork('pools'), addresses, negatives);

  // Round-robin over the regular templates until none can be filled, then the fallbacks absorb what is left.
  const renders = new Map<string, number>();
  const docs: { path: string; text: string; truth: TruthRow[] }[] = [];
  for (const phase of [templates.filter((t) => !t.fallback), templates.filter((t) => t.fallback)]) {
    for (let progress = true; progress;) {
      progress = false;
      for (const t of phase) {
        const done = renders.get(t.path) ?? 0;
        if (done >= t.renders) continue;
        const docId = `${t.lang}-${t.name}-${String(done + 1).padStart(3, '0')}`;
        const doc = renderDocument(t, docId, pools, prng.fork(`docs/${docId}`));
        if (!doc) continue;
        renders.set(t.path, done + 1);
        docs.push({ path: `docs/${docId}.${t.type}`, text: doc.text, truth: doc.truth });
        progress = true;
      }
    }
  }
  const leftovers = [...pools.counts()].filter(([, n]) => n > 0);
  if (leftovers.length > 0 && options.strict !== false) {
    throw new Error(
      `corpus pools not exhausted (add fallback renders): ${leftovers.map(([k, n]) => `${k}=${n}`).join(', ')}`,
    );
  }

  const allNegatives: NegativeRecord[] = [...negatives, ...pools.tokenContracts];
  const truth = docs.flatMap((d) => d.truth);
  const files = new Map<string, string>();
  for (const family of CORPUS_FAMILIES) {
    files.set(`addresses/${family}.jsonl`, jsonl(addresses.filter((a) => a.chain === family)));
  }
  files.set(
    'negatives/hard-negatives.jsonl',
    jsonl(
      allNegatives.toSorted(
        (a, b) =>
          NEGATIVE_KINDS.indexOf(a.kind) - NEGATIVE_KINDS.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
    ),
  );
  for (const d of docs.toSorted((a, b) => (a.path < b.path ? -1 : 1))) files.set(d.path, d.text);
  files.set(
    'ground-truth.jsonl',
    jsonl(truth.toSorted((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.occurrence - b.occurrence))),
  );

  const hashes: Record<string, string> = {};
  for (const [path, text] of [...sources, ...files].toSorted(([a], [b]) => (a < b ? -1 : 1)))
    hashes[path] = sha256Hex(text);
  const positives = truth.filter((r) => r.expected === 'positive');
  const manifest: CorpusManifest = {
    schema: CORPUS_SCHEMA,
    corpusVersion: CORPUS_VERSION,
    generator: { name: '@olcys/address-extractor scripts/corpus/generate.ts', version: GENERATOR_VERSION },
    seed,
    counts: {
      positives: countBy<AddressRecord>(addresses, (a) => a.chain, CORPUS_FAMILIES),
      positivesBySubtype: countBy<AddressRecord>(addresses, (a) => a.subtype, ADDRESS_SUBTYPES),
      upperCaseBech32: addresses.filter((a) => isBech32Subtype(a.subtype) && a.display !== a.canonical).length,
      negatives: countBy<NegativeRecord>(allNegatives, (n) => n.kind, NEGATIVE_KINDS),
      negativesByExpectation: countBy<NegativeRecord>(allNegatives, (n) => n.expected, NEGATIVE_EXPECTATIONS),
      templates: countBy(templates, (t) => t.lang, ['pl', 'en']),
      documents: countBy(docs, (d) => d.path.slice(d.path.lastIndexOf('.') + 1), ['html', 'txt', 'json']),
      truthRows: truth.length,
      secrets: countBy(truth, (r) => r.secretKind, SECRET_KINDS),
      obfuscations: Object.fromEntries(
        OBFUSCATIONS.map((o) => [o, truth.filter((r) => r.obfuscation.includes(o)).length]).filter(([, n]) => n !== 0),
      ),
      channels: countBy(truth, (r) => r.channel, CHANNELS),
    },
    unsupported: UNSUPPORTED,
    files: hashes,
  };
  if (positives.length === 0) throw new Error('corpus without positives');
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { files, manifest, templates };
}
