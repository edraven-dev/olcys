/**
 * Acceptance thresholds of the extraction benchmark (CI gate); labels come from the Polish catalogue (`pl.ts`).
 * Changing a threshold is a decision to record in the methodology note, never a way to make a failing run pass.
 */
import { GATE_PL } from './pl.ts';
import { CORPUS_FAMILIES, type BenchReport, type GateResult, type Metrics } from './types.ts';

export const THRESHOLDS = {
  cleanChecksummedRecall: 0.99,
  cleanChecksummedPrecision: 0.99,
  obfuscatedRecall: 0.9,
  corroboratedUnchecksummedPrecision: 0.9,
  secretRecall: 1,
  secretLeaks: 0,
  minSecrets: 200,
  secretKinds: 4,
} as const;

/** Hard negatives that must never become a candidate at all. */
export const ZERO_CANDIDATE_KINDS = [
  'tx_hash',
  'txid_hex64',
  'ipfs_cid_v0',
  'ipfs_cid_v1',
  'md5',
  'sha1',
  'sha256',
  'git_sha',
  'jwt_like',
  'token_generic',
] as const;
/** BIP-350 wrong-variant vectors: rejected with `bech32_variant_mismatch`. */
export const VARIANT_KINDS = ['v1_in_bech32', 'v0_in_bech32m'] as const;

export interface GateInputs {
  cleanMetrics: Record<string, Metrics>;
  obfuscated: Metrics;
  corroborated: Metrics;
}

function gate(
  id: string,
  label: string,
  metric: GateResult['metric'],
  value: number,
  comparison: GateResult['comparison'],
  threshold: number,
  detail?: string,
): GateResult {
  const passed =
    !Number.isNaN(value) &&
    (comparison === '>=' ? value >= threshold : comparison === '==' ? value === threshold : value < threshold);
  return { id, label, metric, value, threshold, comparison, passed, ...(detail ? { detail } : {}) };
}

export function evaluateGates(report: BenchReport, inputs: GateInputs): GateResult[] {
  const gates: GateResult[] = [];
  // One pair of gates per supported family, even when the corpus holds no clean occurrence of it (then it fails).
  for (const family of CORPUS_FAMILIES) {
    const m = inputs.cleanMetrics[family];
    const detail = m ? `TP ${m.tp}, FP ${m.fp}, FN ${m.fn}` : GATE_PL.missing(family);
    gates.push(
      gate(
        `clean_recall:${family}`,
        GATE_PL.cleanRecall(family),
        'recall',
        m?.recall ?? Number.NaN,
        '>=',
        THRESHOLDS.cleanChecksummedRecall,
        detail,
      ),
      gate(
        `clean_precision:${family}`,
        GATE_PL.cleanPrecision(family),
        'precision',
        m?.precision ?? Number.NaN,
        '>=',
        THRESHOLDS.cleanChecksummedPrecision,
        detail,
      ),
    );
  }
  const o = inputs.obfuscated;
  gates.push(
    gate(
      'obfuscated_recall',
      GATE_PL.obfuscatedRecall,
      'recall',
      o.recall,
      '>=',
      THRESHOLDS.obfuscatedRecall,
      `TP ${o.tp}, FN ${o.fn}`,
    ),
  );
  const c = inputs.corroborated;
  gates.push(
    gate(
      'unchecksummed_corroborated_precision',
      GATE_PL.corroboratedPrecision,
      'precision',
      c.precision,
      '>=',
      THRESHOLDS.corroboratedUnchecksummedPrecision,
      `TP ${c.tp}, FP ${c.fp}`,
    ),
  );
  const s = report.secrets;
  gates.push(
    gate(
      'secret_recall',
      GATE_PL.secretRecall,
      'recall',
      s.recall,
      '==',
      THRESHOLDS.secretRecall,
      `${s.redacted}/${s.total}`,
    ),
    gate('secret_leaks', GATE_PL.secretLeaks, 'value', s.leaks, '==', THRESHOLDS.secretLeaks),
    gate('secret_total', GATE_PL.secretTotal, 'value', s.total, '>=', THRESHOLDS.minSecrets),
    gate('secret_kinds', GATE_PL.secretKinds, 'value', Object.keys(s.byKind).length, '>=', THRESHOLDS.secretKinds),
  );
  // Every hash-like kind must be present in the corpus; a missing kind fails instead of counting as 0 accepted.
  const missing = ZERO_CANDIDATE_KINDS.filter((k) => (report.negatives[k]?.total ?? 0) === 0);
  const accepted = ZERO_CANDIDATE_KINDS.reduce((n, k) => n + (report.negatives[k]?.accepted ?? 0), 0);
  gates.push(
    gate(
      'hash_like_candidates',
      GATE_PL.hashLike,
      'value',
      missing.length > 0 ? Number.NaN : accepted,
      '==',
      0,
      missing.length > 0 ? GATE_PL.missing(missing.join(', ')) : undefined,
    ),
  );
  const variants = VARIANT_KINDS.map((k) => report.negatives[k]);
  const total = variants.reduce((n, v) => n + (v?.total ?? 0), 0);
  const rejected = variants.reduce((n, v) => n + (v?.rejectedAsExpected ?? 0), 0);
  gates.push(
    gate(
      'bech32_variant_mismatch',
      GATE_PL.variantMismatch,
      'recall',
      variants.some((v) => !v || v.total === 0) ? Number.NaN : rejected / total,
      '==',
      1,
      `${rejected}/${total}`,
    ),
  );
  gates.push(
    gate(
      'spiderfoot_hard_negative_precision',
      GATE_PL.spiderfoot,
      'precision',
      report.hardNegativeDocuments.spiderfoot.precision,
      '<',
      report.hardNegativeDocuments.ours.precision,
    ),
  );
  return gates;
}
