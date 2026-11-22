/**
 * Score calibration harness (offline): draws labelled synthetic claims, scores them with the engine and measures
 * how well the probabilities match the labels.
 *
 *   node scripts/calibrate.ts [--weights <yaml>] [--scenarios <yaml> | --oracle] [--n 20000] [--seed 20261121]
 *                             [--corpus <dir>|none] [--corpus-limit <n>] [--propose] [--out data/calibration]
 *
 * Writes <out>/<algorithmVersion>/<weightsVersion>/<seed>[-oracle]/{report.json,reliability.svg,report.md} (and, with
 * --propose, weights.v2-proposed.yaml next to them). Never touches config/scoring. Exits with 1 when the persona set
 * is not reproduced (the report is written anyway). Synthetic calibration checks the mechanics, not real-world LRs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  calibrate,
  generateClaims,
  loadWeights,
  oracleScenarios,
  parsePersonaSet,
  parseScenarios,
  proposeWeights,
  reliabilitySvg,
  reportMarkdown,
  scorePersona,
  serialiseReport,
  weightsPath,
} from '../src/index.ts';
import { corpusPresent, corpusRelations } from './lib/corpus.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const DEFAULT_SEED = 20261121;
export const DEFAULT_N = 20000;

export interface RunOptions {
  weights?: string;
  scenarios?: string;
  oracle?: boolean;
  n?: number;
  seed?: number;
  corpus?: string;
  corpusLimit?: number;
  propose?: boolean;
  out?: string;
}

/** Parses a CLI integer strictly (digits only, within [min, max]); throws `Error` with a clear message otherwise. */
export function parseInteger(name: string, text: string, min: number, max: number): number {
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}, got "${text}"`);
  }
  return value;
}

export const MAX_N = 1_000_000;
export const MAX_SEED = 4_294_967_295;

function checkNumber(name: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined) parseInteger(name, String(value), min, max);
}

/** Runs the harness and writes its outputs; returns the output directory and the failed persona claims. */
export async function run(o: RunOptions): Promise<{ dir: string; personaFailures: string[] }> {
  checkNumber('n', o.n, 1, MAX_N);
  checkNumber('seed', o.seed, 0, MAX_SEED);
  checkNumber('corpus-limit', o.corpusLimit, 1, MAX_N);
  const w = await loadWeights(o.weights ? resolve(o.weights) : weightsPath());
  const seed = o.seed ?? DEFAULT_SEED;
  const n = o.n ?? DEFAULT_N;
  const tierOf = (feature: string) => w.features.get(feature)?.tier;
  const specs = o.oracle
    ? oracleScenarios(w)
    : parseScenarios(
        await readFile(resolve(o.scenarios ?? join(REPO, 'fixtures', 'calibration', 'scenarios.v1.yaml')), 'utf8'),
      ).scenarios;
  const claims = generateClaims(specs, n, seed, tierOf);

  const persona = scorePersona(
    parsePersonaSet(await readFile(join(REPO, 'fixtures', 'calibration', 'persona.v1.yaml'), 'utf8')).cases,
    w,
  );

  const corpusDir = o.corpus === 'none' ? undefined : resolve(o.corpus ?? join(REPO, 'fixtures', 'corpus'));
  const corpus =
    corpusDir && corpusPresent(corpusDir)
      ? await corpusRelations(
          corpusDir,
          w,
          await readFile(join(REPO, 'config', 'rules', 'deny-list.v1.yaml'), 'utf8'),
          o.corpusLimit === undefined ? {} : { limit: o.corpusLimit },
        )
      : undefined;

  const report = calibrate(claims, w, {
    seed,
    mode: o.oracle ? 'oracle' : 'scenarios',
    persona,
    ...(corpus ? { relationPairs: corpus.pairs, relationUnmatched: corpus.unmatched, corpus: corpus.provenance } : {}),
  });

  const dir = join(
    resolve(o.out ?? join(REPO, 'data', 'calibration')),
    report.algorithmVersion,
    report.weightsVersion,
    `${seed}${o.oracle ? '-oracle' : ''}`,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.json'), serialiseReport(report));
  await writeFile(join(dir, 'reliability.svg'), reliabilitySvg(report));
  await writeFile(join(dir, 'report.md'), reportMarkdown(report));
  if (o.propose) await writeFile(join(dir, 'weights.v2-proposed.yaml'), proposeWeights(report, w));
  return {
    dir,
    personaFailures: persona.filter((p) => p.got !== p.expected).map((p) => `${p.claim} (${p.expected} ≠ ${p.got})`),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      weights: { type: 'string' },
      scenarios: { type: 'string' },
      oracle: { type: 'boolean' },
      n: { type: 'string' },
      seed: { type: 'string' },
      corpus: { type: 'string' },
      'corpus-limit': { type: 'string' },
      propose: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const { dir, personaFailures } = await run({
    ...(values.weights ? { weights: values.weights } : {}),
    ...(values.scenarios ? { scenarios: values.scenarios } : {}),
    ...(values.oracle ? { oracle: true } : {}),
    ...(values.n !== undefined ? { n: parseInteger('n', values.n, 1, MAX_N) } : {}),
    ...(values.seed !== undefined ? { seed: parseInteger('seed', values.seed, 0, MAX_SEED) } : {}),
    ...(values.corpus ? { corpus: values.corpus } : {}),
    ...(values['corpus-limit'] !== undefined
      ? { corpusLimit: parseInteger('corpus-limit', values['corpus-limit'], 1, MAX_N) }
      : {}),
    ...(values.propose ? { propose: true } : {}),
    ...(values.out ? { out: values.out } : {}),
  });
  console.info(`calibrate: report in ${dir}`);
  if (personaFailures.length > 0) {
    console.error(`calibrate: persona set not reproduced: ${personaFailures.join(', ')}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`calibrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
