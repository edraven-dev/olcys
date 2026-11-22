import {
  ADMIRALTY_RELIABILITY,
  RELATIONS,
  type AdmiraltyReliability,
  type EvidenceFeature,
  type EvidenceTier,
  type Hop,
  type Relation,
} from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { discount } from '../hop.ts';
import type { ClaimInput, PathInput } from '../link.ts';
import { RELATION_RULES_VERSION } from '../version.ts';
import type { ScoringWeights } from '../weights.ts';
import { createIdFactory } from './ids.ts';
import { Rng } from './prng.ts';

/** One feature a scenario emits, with the probability of emitting it per claim. */
export interface ScenarioFeature {
  feature: string;
  /** Probability that the feature is present in a claim of this scenario. */
  p: number;
  /** Admiralty grade of the emitted items (default `A`). */
  grade?: AdmiraltyReliability;
  /** Number of distinct origin groups the copies come from (default 1). */
  originGroups?: number;
  /** Number of copies emitted when the feature is present (default `originGroups`); copy k joins group k mod originGroups. */
  copies?: number;
}

/** A class of synthetic claims with a known ground truth. */
export interface ScenarioSpec {
  id: string;
  /** Scenario name used in the report when several specs form one scenario (default: `id`). */
  group?: string;
  /** Probability that a claim of this scenario is a true ownership link (0 or 1 = fixed). Ignored when `hop` is set. */
  label: number;
  /** Share of the generated claims. */
  weight: number;
  relation: Relation;
  anchor: boolean;
  identity: ScenarioFeature[];
  address: ScenarioFeature[];
  /** Ground truth per hop (oracle scenarios): the label is true only when both hops are. */
  hop?: { identity: 0 | 1; address: 0 | 1 };
}

export interface LabelledClaim {
  claim: ClaimInput;
  label: 0 | 1;
  scenario: string;
  /** Hop truth, when the generator knows it (oracle mode): used to measure per-feature likelihood ratios. */
  hop?: { identity: 0 | 1; address: 0 | 1 };
}

/** Relations that carry no ownership arithmetic (the engine does not assess them): never generated. */
const NOT_ASSESSED: ReadonlySet<Relation> = new Set([
  'THIRD_PARTY_ATTRIBUTION',
  'TX_COUNTERPARTY',
  'CLUSTER_ASSOCIATED',
]);

const TIER_RANK: readonly EvidenceTier[] = ['E1', 'E2', 'E3', 'E4', 'AUTH'];

/** Largest-remainder allocation of `n` claims over the scenario weights (deterministic, sums to n). */
function allocate(weights: readonly number[], n: number): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map((w) => (n * w) / total);
  const counts = exact.map(Math.floor);
  let rest = n - counts.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).toSorted((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    counts[i] = (counts[i] ?? 0) + 1;
    rest -= 1;
  }
  return counts;
}

function emit(
  hop: Hop,
  features: readonly ScenarioFeature[],
  rng: Rng,
  tierOf: (feature: string) => EvidenceTier | undefined,
  tiers: Set<EvidenceTier>,
): EvidenceFeature[] {
  const items: EvidenceFeature[] = [];
  for (const f of features) {
    if (!rng.chance(f.p)) continue;
    const groups = Math.max(1, f.originGroups ?? 1);
    const copies = Math.max(1, f.copies ?? groups);
    const tier = tierOf(f.feature);
    if (tier) tiers.add(tier);
    for (let k = 0; k < copies; k += 1) {
      items.push({
        hop,
        feature: f.feature,
        reliability: f.grade ?? 'A',
        originGroup: `acct:calibration:${k % groups}`,
        evidence: {},
      });
    }
  }
  return items;
}

/**
 * Draws `n` labelled claims from the scenarios: counts follow the weights (largest remainder), each feature is a
 * Bernoulli draw, labels are fixed or Bernoulli per scenario. Seeded and deterministic. `tierOf` gives the evidence
 * tier of a feature key (the strongest emitted address tier becomes the claim's tier, default E3).
 */
export function generateClaims(
  specs: readonly ScenarioSpec[],
  n: number,
  seed: number,
  tierOf: (feature: string) => EvidenceTier | undefined = () => undefined,
): LabelledClaim[] {
  const active = specs.filter((s) => !NOT_ASSESSED.has(s.relation));
  const rng = new Rng(seed);
  const newId = createIdFactory(seed);
  const runId = newId();
  const identityId = newId();
  const counts = allocate(
    active.map((s) => s.weight),
    n,
  );
  const out: LabelledClaim[] = [];
  active.forEach((spec, si) => {
    for (let j = 0; j < (counts[si] ?? 0); j += 1) {
      const tiers = new Set<EvidenceTier>();
      const identity = spec.anchor ? [] : emit('identity', spec.identity, rng, tierOf, new Set());
      const address = emit('address', spec.address, rng, tierOf, tiers);
      const label: 0 | 1 = spec.hop
        ? spec.hop.identity === 1 && spec.hop.address === 1
          ? 1
          : 0
        : spec.label >= 1
          ? 1
          : spec.label <= 0
            ? 0
            : rng.chance(spec.label)
              ? 1
              : 0;
      const path: PathInput = {
        anchor: spec.anchor,
        identity,
        address,
        service: 'calibration',
        originGroup: 'acct:calibration:0',
      };
      out.push({
        claim: {
          runId,
          identityId,
          address: { chain: 'bitcoin', address: `synthetic-${si}-${j}` },
          relation: spec.relation,
          tier: TIER_RANK.find((t) => tiers.has(t)) ?? 'E3',
          checksum: { scheme: 'none', present: false, valid: true, bits: 0 },
          paths: [path],
          exclusions: [],
          reviewRequired: false,
          rulesVersion: RELATION_RULES_VERSION,
        },
        label,
        scenario: spec.group ?? spec.id,
        ...(spec.hop ? { hop: spec.hop } : {}),
      });
    }
  });
  return out;
}

/**
 * Largest gap m − u between the emission probabilities of a feature in the two classes. The engine treats absence as
 * neutral, but an absent feature has the likelihood ratio (1 − m) / (1 − u); the oracle is only calibrated when
 * that stays close to 1, so features are rare (weak features, whose ratio is near 1, may be frequent).
 */
export const ORACLE_EMISSION = 0.04;

const odds = (o: number): number => o / (1 + o);

/** Share of anchored claims in the oracle mix. */
export const ORACLE_ANCHOR_SHARE = 0.25;

/**
 * Scenarios whose feature emission follows the weights themselves: for each feature m / u = BF′ (at its default
 * grade; `A` without one) and the class prior is the weights' prior odds (anchored identities: the anchor
 * probability). A correct engine is calibrated on them, so this checks the harness and the dedup rules, not the
 * weights. One scenario per hop truth: label 1 only when both hops are true.
 */
export function oracleScenarios(w: ScoringWeights, emission: number = ORACLE_EMISSION): ScenarioSpec[] {
  const features = (hop: Hop, truth: boolean): ScenarioFeature[] => {
    const out: ScenarioFeature[] = [];
    for (const f of w.features.values()) {
      if (f.hop !== hop) continue;
      const grade = f.defaultGrade ?? 'A';
      const rho = w.reliability[grade];
      if (rho === null || rho === undefined) continue;
      const bf = discount(f.bayesFactor, rho);
      const ratio = Math.max(bf, 1 / bf);
      // m − u = big · (1 − 1 / ratio) = emission: the more discriminating the feature, the rarer it is.
      const big = Math.min(0.5, emission / (1 - 1 / ratio || 1));
      const small = big / ratio;
      const p = bf >= 1 ? (truth ? big : small) : truth ? small : big;
      out.push({ feature: f.key, p, grade });
    }
    return out;
  };
  const pIdentity = odds(w.identity.priorOdds);
  const pAddress = odds(w.address.priorOdds);
  const specs: ScenarioSpec[] = [];
  for (const anchor of [true, false]) {
    const share = anchor ? ORACLE_ANCHOR_SHARE : 1 - ORACLE_ANCHOR_SHARE;
    const idTrue = anchor ? w.identity.anchorProbability : pIdentity;
    for (const i of [1, 0] as const) {
      for (const a of [1, 0] as const) {
        specs.push({
          id: `oracle:${anchor ? 'anchor' : 'enumerated'}:id${i}:addr${a}`,
          group: `oracle:${anchor ? 'anchor' : 'enumerated'}`,
          label: i === 1 && a === 1 ? 1 : 0,
          weight: share * (i === 1 ? idTrue : 1 - idTrue) * (a === 1 ? pAddress : 1 - pAddress),
          relation: 'SELF_DECLARED',
          anchor,
          identity: anchor ? [] : features('identity', i === 1),
          address: features('address', a === 1),
          hop: { identity: i, address: a },
        });
      }
    }
  }
  return specs;
}

function fail(message: string): never {
  throw new Error(`scenarios: ${message}`);
}

function parseFeatures(value: unknown, where: string): ScenarioFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${where} must be a list`);
  return value.map((raw, i) => {
    const f = raw as Record<string, unknown>;
    const at = `${where}[${i}]`;
    if (typeof f['feature'] !== 'string') return fail(`${at}.feature must be a string`);
    const p = f['p'];
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return fail(`${at}.p must be a number in [0, 1]`);
    const grade = f['grade'];
    if (grade !== undefined && !(ADMIRALTY_RELIABILITY as readonly unknown[]).includes(grade)) {
      return fail(`${at}.grade must be one of ${ADMIRALTY_RELIABILITY.join(', ')}`);
    }
    const count = (key: 'originGroups' | 'copies'): number | undefined => {
      const v = f[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
        return fail(`${at}.${key} must be a positive integer`);
      return v;
    };
    const originGroups = count('originGroups');
    const copies = count('copies');
    return {
      feature: f['feature'],
      p,
      ...(grade === undefined ? {} : { grade: grade as AdmiraltyReliability }),
      ...(originGroups === undefined ? {} : { originGroups }),
      ...(copies === undefined ? {} : { copies }),
    };
  });
}

/** Parses a scenario file (`fixtures/calibration/scenarios.v1.yaml`). Throws `Error` on any schema problem. */
export function parseScenarios(text: string): { version: string; scenarios: ScenarioSpec[] } {
  const doc = parseYaml(text, { uniqueKeys: true }) as Record<string, unknown> | null;
  if (!doc || typeof doc['version'] !== 'string') return fail('`version` is required');
  const list = doc['scenarios'];
  if (!Array.isArray(list) || list.length === 0) return fail('`scenarios` must be a non-empty list');
  const ids = new Set<string>();
  const scenarios = list.map((raw, i): ScenarioSpec => {
    const s = raw as Record<string, unknown>;
    const at = `scenarios[${i}]`;
    if (typeof s['id'] !== 'string' || s['id'] === '') return fail(`${at}.id must be a string`);
    if (ids.has(s['id'])) return fail(`${at}.id "${s['id']}" is duplicated`);
    ids.add(s['id']);
    const label = s['label'];
    if (typeof label !== 'number' || !(label >= 0 && label <= 1)) return fail(`${at}.label must be in [0, 1]`);
    const weight = s['weight'];
    if (typeof weight !== 'number' || !(weight > 0)) return fail(`${at}.weight must be positive`);
    const relation = s['relation'];
    if (!(RELATIONS as readonly unknown[]).includes(relation)) return fail(`${at}.relation is not a relation`);
    if (NOT_ASSESSED.has(relation as Relation)) return fail(`${at}.relation ${relation as string} is not assessed`);
    if (typeof s['anchor'] !== 'boolean') return fail(`${at}.anchor must be a boolean`);
    return {
      id: s['id'],
      label,
      weight,
      relation: relation as Relation,
      anchor: s['anchor'],
      identity: parseFeatures(s['identity'], `${at}.identity`),
      address: parseFeatures(s['address'], `${at}.address`),
    };
  });
  return { version: doc['version'], scenarios };
}
