import type { Id, IsoDateTime } from './common.ts';

/** Run-to-run differences. VALUE_CHANGED on a wallet property is the "wallet swapped" alert. */
export const CHANGE_KINDS = ['ADDED', 'REMOVED', 'VALUE_CHANGED', 'SCORE_CHANGED'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeEvent {
  id: Id;
  runId: Id;
  previousRunId: Id;
  kind: ChangeKind;
  key: { identityId?: Id; platform: string; locator: string; property: string };
  before?: string;
  after?: string;
  beforeCaptureId?: Id;
  afterCaptureId?: Id;
  scoreBefore?: number;
  scoreAfter?: number;
  /** For SCORE_CHANGED: whether data, the algorithm version, or both changed. */
  cause?: 'data' | 'algorithm' | 'both';
  detectedAt: IsoDateTime;
}
