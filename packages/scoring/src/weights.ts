import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADMIRALTY_RELIABILITY,
  ContractError,
  parse,
  WeightsConfigSchema,
  type AdmiraltyReliability,
  type EvidenceTier,
  type Hop,
  type Sha256Hex,
  type WeightsConfig,
} from '@olcys/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { parse as parseYaml } from 'yaml';

/** One feature of the weights table, with the hop it belongs to and its dedup family. */
export interface FeatureWeight {
  key: string;
  hop: Hop;
  /** `e1`–`e4` for keys starting with `e1_`…`e4_` (so `e3_ownership_cue` and `e3_bare_mention` share `e3`), else the key. */
  family: string;
  bayesFactor: number;
  defaultGrade?: AdmiraltyReliability;
  tier?: EvidenceTier;
  reviewRequired?: boolean;
  note: string;
}

export interface Icd203Row {
  max: number;
  term: string;
  pl: string;
}

export interface EnfsiRow {
  maxLr: number;
  term: string;
}

export interface ScoringWeights {
  version: string;
  status: 'uncalibrated' | 'calibrated';
  /** SHA-256 of the raw file bytes (equals `sha256sum`); copied into `RunConfigSnapshot.weightsSha256`. */
  sha256: Sha256Hex;
  /** Admiralty grade → ρ; `F` is `null` (an analyst must grade the source first). */
  reliability: Record<AdmiraltyReliability, number | null>;
  identity: { anchorProbability: number; priorOdds: number };
  address: { priorOdds: number };
  features: ReadonlyMap<string, FeatureWeight>;
  scales: { icd203: Icd203Row[]; enfsi: EnfsiRow[] };
}

/** The weights the engine uses unless a run pins another version. */
export const DEFAULT_WEIGHTS_FILE = 'weights.v2.yaml';

/** `<repo>/config/scoring/<file>`. */
export function weightsPath(file: string = DEFAULT_WEIGHTS_FILE): string {
  return join(import.meta.dirname, '..', '..', '..', 'config', 'scoring', file);
}

const FAMILY = /^(e[1-4])_/;

export function featureFamily(key: string): string {
  return FAMILY.exec(key)?.[1] ?? key;
}

function fail(path: string, message: string): never {
  throw new ContractError([{ path, message }]);
}

function checkAscending(values: readonly number[], path: string): void {
  for (let i = 1; i < values.length; i += 1) {
    if (!((values[i] ?? 0) > (values[i - 1] ?? 0))) fail(`${path}.${i}`, 'scale rows must be strictly ascending');
  }
}

function toFeatures(config: WeightsConfig): Map<string, FeatureWeight> {
  const features = new Map<string, FeatureWeight>();
  for (const hop of ['identity', 'address'] as const) {
    for (const [key, f] of Object.entries(config[hop].features)) {
      if (features.has(key)) fail(`${hop}.features.${key}`, 'feature key is defined for both hops');
      features.set(key, {
        key,
        hop,
        family: featureFamily(key),
        bayesFactor: f.bayesFactor,
        ...(f.defaultGrade === undefined ? {} : { defaultGrade: f.defaultGrade }),
        ...(f.tier === undefined ? {} : { tier: f.tier }),
        ...(f.reviewRequired === undefined ? {} : { reviewRequired: f.reviewRequired }),
        note: f.note ?? '',
      });
    }
  }
  return features;
}

/**
 * Parses and validates a weights file. `sha256` is computed over exactly these bytes. Throws `ContractError` on any
 * schema or consistency problem (non-positive ρ for A–E, scales not ascending, last ICD 203 row ≠ 1, last ENFSI
 * row ≠ ∞, a key defined for both hops).
 */
export function parseWeights(bytes: Uint8Array): ScoringWeights {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const config = parse(WeightsConfigSchema, parseYaml(text, { uniqueKeys: true }));

  const reliability = {} as Record<AdmiraltyReliability, number | null>;
  for (const grade of ADMIRALTY_RELIABILITY) {
    const rho = config.reliability[grade];
    if (grade !== 'F' && !(typeof rho === 'number' && rho > 0 && rho <= 1)) {
      fail(`reliability.${grade}`, 'ρ must be in (0, 1]');
    }
    reliability[grade] = rho;
  }

  const icd203 = config.scales.icd203.map((row) => ({ max: row.max, term: row.term, pl: row.pl }));
  const enfsi = config.scales.enfsi.map((row) => ({ maxLr: row.maxLr, term: row.term }));
  checkAscending(
    icd203.map((row) => row.max),
    'scales.icd203',
  );
  checkAscending(
    enfsi.map((row) => row.maxLr),
    'scales.enfsi',
  );
  if (icd203.at(-1)?.max !== 1) fail('scales.icd203', 'the last ICD 203 row must end at 1');
  if (enfsi.at(-1)?.maxLr !== Number.POSITIVE_INFINITY) fail('scales.enfsi', 'the last ENFSI row must be .inf');

  return {
    version: config.version,
    status: config.status,
    sha256: hex.encode(sha256(bytes)),
    reliability,
    identity: { anchorProbability: config.identity.anchorProbability, priorOdds: config.identity.priorOdds },
    address: { priorOdds: config.address.priorOdds },
    features: toFeatures(config),
    scales: { icd203, enfsi },
  };
}

/** Reads a weights file (default: `config/scoring/weights.v2.yaml` of this repository). */
export async function loadWeights(path: string = weightsPath()): Promise<ScoringWeights> {
  return parseWeights(new Uint8Array(await readFile(path)));
}
