import type { AdmiraltyReliability, Clock, EvidenceFeature, Hop } from '@olcys/core';
import { loadWeights, weightsPath, type ScoringWeights } from '../../src/index.ts';

export const v1 = (): Promise<ScoringWeights> => loadWeights(weightsPath('weights.v1.yaml'));
export const v2 = (): Promise<ScoringWeights> => loadWeights();

export const clock: Clock = { now: () => new Date('2026-11-21T12:00:00.000Z') };

/** Deterministic id sequence (UUIDv7-shaped). */
export function idSequence(prefix = '0190'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  };
}

export function feature(
  hop: Hop,
  key: string,
  reliability: AdmiraltyReliability,
  originGroup: string,
  evidence: EvidenceFeature['evidence'] = {},
): EvidenceFeature {
  return { hop, feature: key, reliability, originGroup, evidence };
}
