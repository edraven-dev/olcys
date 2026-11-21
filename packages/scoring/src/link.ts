import {
  addressKey,
  NOT_ASSESSED,
  type AddressRef,
  type AdmiraltyReliability,
  type AnalyticConfidence,
  type ChecksumInfo,
  type Clock,
  type EvidenceFeature,
  type EvidenceTier,
  type ExclusionDecision,
  type FeatureContribution,
  type Id,
  type LinkAssessment,
  type LinkGate,
  type LinkPath,
  type Relation,
  type TraceSynergy,
} from '@olcys/core';
import { compareText } from './compare.ts';
import { scoreHop } from './hop.ts';
import { icd203Term, scoreBand } from './scales.ts';
import { ALGORITHM_VERSION } from './version.ts';
import type { ScoringWeights } from './weights.ts';

/** One route from the subject to the address through one account. */
export interface PathInput {
  accountId?: Id;
  /** The account is the investigator-supplied anchor: the identity hop is fixed at `anchorProbability`. */
  anchor: boolean;
  identity: EvidenceFeature[];
  address: EvidenceFeature[];
  /** Service (platform) of the account. Only the strongest path per service is combined; default: its own service. */
  service?: string;
  /** Origin group of the account, e.g. `acct:wykop:fikcyjny_kacper`. */
  originGroup?: string;
}

/** A claim (identity, address, relation) with everything the engine needs to score it. */
export interface ClaimInput {
  runId: Id;
  identityId: Id;
  address: AddressRef;
  relation: Relation;
  tier: EvidenceTier;
  checksum: ChecksumInfo;
  paths: PathInput[];
  /** Exclusion decisions for this address (decisions for other addresses are ignored). */
  exclusions: ExclusionDecision[];
  /** Every item comes from a deobfuscated or OCR-repaired match (analyst confirmation needed). */
  reviewRequired: boolean;
  /** Unconfirmed LLM suggestions left out of the arithmetic (they never become features). */
  llmSuggestionsExcluded?: number;
  rulesVersion: string;
}

export type ScoreResult =
  | { ok: true; assessment: LinkAssessment }
  | { ok: false; reason: 'invalid_checksum' | 'no_paths' };

/** Relations that never carry ownership arithmetic: scored 0, `icd203` = `not assessed`. */
const NOT_OWNERSHIP: ReadonlySet<Relation> = new Set([
  'THIRD_PARTY_ATTRIBUTION',
  'TX_COUNTERPARTY',
  'CLUSTER_ASSOCIATED',
]);

const RELATION_GATE_DETAIL: Record<Relation, string> = {
  SELF_DECLARED: 'SELF_DECLARED: ownership claim',
  PAYMENT_ENDPOINT: 'PAYMENT_ENDPOINT: ownership claim (payment or donation endpoint)',
  MENTION_UNCLEAR: 'MENTION_UNCLEAR: ownership claim from a mention without a clear role',
  CUSTODIAL_EXCHANGE:
    'CUSTODIAL_EXCHANGE: exchange deposit, the interaction is recorded but never attributed as a private wallet',
  THIRD_PARTY_ATTRIBUTION: 'THIRD_PARTY_ATTRIBUTION: a different relation, not ownership evidence',
  TX_COUNTERPARTY: 'TX_COUNTERPARTY: transaction counterparty, not an ownership claim',
  CLUSTER_ASSOCIATED: 'CLUSTER_ASSOCIATED: cluster association, not an ownership claim',
};

const GRADE_RANK: Record<AdmiraltyReliability, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

/** Noisy-OR over independent paths: 1 − Π(1 − p). */
export function combinePaths(p: readonly number[]): number {
  return 1 - p.reduce((product, value) => product * (1 - value), 1);
}

const toScore = (probability: number): number => Math.round(100 * probability);

const counted = (contributions: readonly FeatureContribution[]): FeatureContribution[] =>
  contributions.filter((c) => c.counted);

function serviceKey(path: PathInput, index: number): string {
  return path.service ?? path.originGroup ?? path.accountId ?? `path:${index + 1}`;
}

function strongIdentity(path: LinkPath): boolean {
  return path.anchor === true || counted(path.identityHop.contributions).some((c) => c.bayesFactor >= 32 && c.bits > 0);
}

/**
 * Analytic confidence (High / Moderate / Low), kept apart from the likelihood as ICD 203 requires. Low: not assessed,
 * a counted contradicting attribute, review-only evidence, no strong identity hop, or best positive address grade C–E.
 * High: a strong identity hop (anchor or a counted identity feature with BF ≥ 32) with a counted cryptographic
 * binding graded A/B, or ≥ 2 independent origin groups graded A/B with counted on-chain consistency.
 */
export function analyticConfidence(paths: readonly LinkPath[], claim: ClaimInput): AnalyticConfidence {
  if (NOT_OWNERSHIP.has(claim.relation) || paths.length === 0 || claim.reviewRequired) return 'Low';
  const all = paths.flatMap((p) => [...counted(p.identityHop.contributions), ...counted(p.addressHop.contributions)]);
  if (all.some((c) => c.feature === 'contradicting_attribute')) return 'Low';

  const positive = paths.flatMap((p) => counted(p.addressHop.contributions).filter((c) => c.bits > 0));
  const bestGrade = Math.min(...positive.map((c) => GRADE_RANK[c.reliability]));
  const goodGrade = bestGrade <= GRADE_RANK.B;

  const cryptoBound = paths.some(
    (p) =>
      strongIdentity(p) &&
      counted(p.addressHop.contributions).some(
        (c) => c.feature === 'e1_cryptographic_binding' && GRADE_RANK[c.reliability] <= GRADE_RANK.B,
      ),
  );
  const origins = new Set(positive.filter((c) => GRADE_RANK[c.reliability] <= GRADE_RANK.B).map((c) => c.originGroup));
  const ledger = paths.some((p) =>
    counted(p.addressHop.contributions).some((c) => c.feature === 'onchain_consistency'),
  );
  if (cryptoBound || (origins.size >= 2 && goodGrade && ledger)) return 'High';

  if (!paths.some(strongIdentity) || !goodGrade) return 'Low';
  return 'Moderate';
}

function exclusionGate(decision: ExclusionDecision): LinkGate {
  const head = `${decision.ruleId} ${decision.outcome}${decision.relation ? ` → ${decision.relation}` : ''}`;
  const kappa = decision.evidence.kappa === undefined ? '' : `, κ=${decision.evidence.kappa}`;
  const detail = `${head}${kappa}: ${decision.reason}`;
  return {
    gate: 'exclusion',
    passed: decision.outcome !== 'excluded' && decision.outcome !== 'reclassified',
    detail: detail.length > 200 ? `${detail.slice(0, 199)}…` : detail,
  };
}

function checksumGate(checksum: ChecksumInfo): LinkGate {
  return {
    gate: 'checksum',
    passed: true,
    detail: checksum.present ? `${checksum.scheme}, ${checksum.bits} bits` : 'format without a checksum',
  };
}

interface ScoredPaths {
  paths: LinkPath[];
  /** Service key per path (same index). */
  services: string[];
}

function buildPaths(c: ClaimInput, w: ScoringWeights): ScoredPaths {
  const services = c.paths.map(serviceKey);
  const paths: LinkPath[] = c.paths.map((p) => {
    const identityHop = scoreHop('identity', p.identity, w, { anchor: p.anchor });
    const addressHop = scoreHop('address', p.address, w);
    return {
      ...(p.accountId === undefined ? {} : { accountId: p.accountId }),
      identityHop,
      addressHop,
      probability: identityHop.probability * addressHop.probability,
      anchor: p.anchor,
      ...(p.service === undefined ? {} : { service: p.service }),
      ...(p.originGroup === undefined ? {} : { originGroup: p.originGroup }),
      counted: false,
    };
  });
  // Repeats within one service are not independent sources: only the strongest path per service is combined.
  const best = new Map<string, LinkPath>();
  paths.forEach((path, i) => {
    const key = services[i] ?? '';
    const current = best.get(key);
    if (!current || path.probability > current.probability) best.set(key, path);
  });
  for (const path of best.values()) path.counted = true;
  return { paths, services };
}

function synergyOf({ paths, services }: ScoredPaths, combined: number): TraceSynergy {
  const sources = paths.flatMap((p, i) => (p.counted ? [services[i] ?? ''] : []));
  const best = Math.max(0, ...paths.filter((p) => p.counted).map((p) => p.probability));
  return {
    independentSources: [...new Set(sources)].toSorted(compareText),
    bestSingleScore: toScore(best),
    bonusPoints: toScore(combined) - toScore(best),
    repeatedPaths: paths.filter((p) => !p.counted).length,
    repeatedItems: paths
      .flatMap((p) => [...p.identityHop.contributions, ...p.addressHop.contributions])
      .filter((c) => c.uncountedReason === 'same_origin_repeat').length,
  };
}

/**
 * Scores one claim. Hard gates sit outside the arithmetic: an invalid checksum yields no claim; a relation other than
 * ownership (third-party attribution, counterparty, cluster) is not assessed; a custodial-exchange relation or an
 * `excluded`/`reclassified` exclusion rejects the link — `probability` and `score` become 0 (band `WYKLUCZENIE`) and
 * the arithmetic stays visible in `paths` and `ungated`.
 */
export function scoreLink(c: ClaimInput, w: ScoringWeights, deps: { clock: Clock; newId: () => Id }): ScoreResult {
  if (!c.checksum.valid) return { ok: false, reason: 'invalid_checksum' };
  const notOwnership = NOT_OWNERSHIP.has(c.relation);
  if (!notOwnership && c.paths.length === 0) return { ok: false, reason: 'no_paths' };

  const scored: ScoredPaths = notOwnership ? { paths: [], services: [] } : buildPaths(c, w);
  const { paths } = scored;
  const combined = combinePaths(paths.filter((p) => p.counted).map((p) => p.probability));

  const key = addressKey(c.address);
  const gates: LinkGate[] = [
    {
      gate: 'relation',
      passed: !notOwnership && c.relation !== 'CUSTODIAL_EXCHANGE',
      detail: RELATION_GATE_DETAIL[c.relation],
    },
    ...c.exclusions
      .filter((d) => addressKey(d.address) === key)
      .toSorted((a, b) => compareText(a.ruleId, b.ruleId) || compareText(a.id, b.id))
      .map(exclusionGate),
    checksumGate(c.checksum),
  ];
  if (paths.some((p) => p.anchor)) {
    gates.push({
      gate: 'identity_anchor',
      passed: true,
      detail: `P = ${w.identity.anchorProbability} assumption: identifier supplied by the investigator for this platform`,
    });
  }
  const ungraded = paths
    .flatMap((p) => [...p.identityHop.contributions, ...p.addressHop.contributions])
    .filter((x) => x.uncountedReason === 'ungraded').length;
  if (ungraded > 0) {
    gates.push({ gate: 'analyst_grading', passed: true, detail: `${ungraded} ungraded item(s) (F) not counted` });
  }
  if (c.reviewRequired) {
    gates.push({
      gate: 'review_required',
      passed: true,
      detail: 'evidence comes only from deobfuscated or OCR-repaired matches: analyst confirmation needed',
    });
  }
  const llm = c.llmSuggestionsExcluded ?? 0;
  if (llm > 0) {
    gates.push({
      gate: 'llm_zero_weight',
      passed: true,
      detail: `${llm} unconfirmed LLM suggestion(s) excluded from the arithmetic`,
    });
  }

  const rejected = gates.some((g) => !g.passed);
  const probability = rejected ? 0 : combined;
  const assessment: LinkAssessment = {
    id: deps.newId(),
    runId: c.runId,
    identityId: c.identityId,
    address: c.address,
    relation: c.relation,
    tier: c.tier,
    paths,
    probability,
    score: toScore(probability),
    icd203: notOwnership ? NOT_ASSESSED : icd203Term(probability, w),
    analyticConfidence: analyticConfidence(paths, c),
    gates,
    band: scoreBand(toScore(probability), rejected),
    ...(rejected && paths.length > 0
      ? { ungated: { probability: combined, score: toScore(combined), icd203: icd203Term(combined, w) } }
      : {}),
    ...(paths.length > 0 ? { synergy: synergyOf(scored, combined) } : {}),
    algorithmVersion: ALGORITHM_VERSION,
    weightsVersion: w.version,
    weightsSha256: w.sha256,
    rulesVersion: c.rulesVersion,
    computedAt: deps.clock.now().toISOString(),
  };
  return { ok: true, assessment };
}
