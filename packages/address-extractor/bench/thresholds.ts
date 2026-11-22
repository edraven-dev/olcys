/**
 * Acceptance thresholds of the extraction benchmark (CI gate). Labels are Polish: they appear in `report.md`.
 * Changing a threshold is a decision to record in the methodology note, never a way to make a failing run pass.
 */
import type { BenchReport, GateResult, Metrics } from './types.ts';

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

const FAMILY_PL: Record<string, string> = { bitcoin: 'Bitcoin', evm: 'EVM', tron: 'TRON' };

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
  for (const [family, m] of Object.entries(inputs.cleanMetrics)) {
    const name = FAMILY_PL[family] ?? family;
    const counts = `TP ${m.tp}, FP ${m.fp}, FN ${m.fn}`;
    gates.push(
      gate(
        `clean_recall:${family}`,
        `${name}: czułość, czyste formaty z sumą kontrolną`,
        'recall',
        m.recall,
        '>=',
        THRESHOLDS.cleanChecksummedRecall,
        counts,
      ),
      gate(
        `clean_precision:${family}`,
        `${name}: precyzja, czyste formaty z sumą kontrolną`,
        'precision',
        m.precision,
        '>=',
        THRESHOLDS.cleanChecksummedPrecision,
        counts,
      ),
    );
  }
  const o = inputs.obfuscated;
  gates.push(
    gate(
      'obfuscated_recall',
      'Czułość na zaciemnionych wystąpieniach',
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
      'Precyzja formatów bez sumy kontrolnej potwierdzonych URI, eksploratorem lub słowem kluczowym',
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
      'Czułość maskowania sekretów',
      'recall',
      s.recall,
      '==',
      THRESHOLDS.secretRecall,
      `${s.redacted}/${s.total}`,
    ),
    gate('secret_leaks', 'Wycieki fragmentów sekretów (wyniki i logi)', 'value', s.leaks, '==', THRESHOLDS.secretLeaks),
    gate('secret_total', 'Liczba sekretów w korpusie', 'value', s.total, '>=', THRESHOLDS.minSecrets),
    gate(
      'secret_kinds',
      'Liczba rodzajów sekretów',
      'value',
      Object.keys(s.byKind).length,
      '>=',
      THRESHOLDS.secretKinds,
    ),
  );
  const accepted = ZERO_CANDIDATE_KINDS.reduce((n, k) => n + (report.negatives[k]?.accepted ?? 0), 0);
  gates.push(
    gate(
      'hash_like_candidates',
      'Kandydaci ze skrótów transakcji, CID IPFS, skrótów MD5/SHA/git, ciągów JWT i tokenów',
      'value',
      accepted,
      '==',
      0,
    ),
  );
  const variants = VARIANT_KINDS.map((k) => report.negatives[k]);
  const total = variants.reduce((n, v) => n + (v?.total ?? 0), 0);
  const rejected = variants.reduce((n, v) => n + (v?.rejectedAsExpected ?? 0), 0);
  gates.push(
    gate(
      'bech32_variant_mismatch',
      'Wektory v1 w bech32 i v0 w bech32m odrzucone jako bech32_variant_mismatch',
      'recall',
      total === 0 ? Number.NaN : rejected / total,
      '==',
      1,
      `${rejected}/${total}`,
    ),
  );
  const ours = report.hardNegativeDocuments.ours.precision;
  const sf = report.hardNegativeDocuments.spiderfoot.precision;
  gates.push(
    gate(
      'spiderfoot_hard_negative_precision',
      'SpiderFoot: precyzja na dokumentach z trudnymi negatywami niższa niż OŁCyŚ',
      'precision',
      sf,
      '<',
      ours,
    ),
  );
  return gates;
}
