import type { ChainId } from './chains.ts';
import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { FetchMode } from './provenance.ts';
import type { SourceId } from './sources.ts';

export const IDENTIFIER_KINDS = [
  'full_name',
  'nickname',
  'messenger_id',
  'social_login',
  'email',
  'crypto_address',
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** An input identifier supplied by the investigator for a case. */
export interface Identifier {
  id: Id;
  caseId: Id;
  kind: IdentifierKind;
  value: string;
  /** Platform the identifier belongs to, when known (e.g. `bitcointalk`, `telegram`, `github`). */
  platform?: string;
  /** Set for `crypto_address` identifiers. */
  chain?: ChainId;
  /**
   * True when the investigator states the identifier belongs to the subject on `platform`.
   * Anchors enter the identity hop with P = 0.99 as a recorded assumption (see weights.v1.yaml).
   */
  isAnchor: boolean;
  addedAt: IsoDateTime;
  addedBy: string;
}

export interface CaseScope {
  /** Sources enabled for this case (AMBER sources need an entry in `amberJustifications`). */
  enabledSources: SourceId[];
  amberJustifications: Record<SourceId, string>;
  chains: ChainId[];
  /** How many pivot generations the planner may expand from the input identifiers. */
  maxPivotDepth: number;
}

export interface CaseSchedule {
  /** Cron expression evaluated in UTC. */
  cron: string;
  enabled: boolean;
}

export interface Case {
  id: Id;
  title: string;
  /** Purpose limitation: why this case exists (GDPR/RODO art. 5(1)(b)). */
  purpose: string;
  legalBasis: string;
  status: 'open' | 'closed';
  scope: CaseScope;
  schedule?: CaseSchedule;
  createdAt: IsoDateTime;
  createdBy: string;
}

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['manual', 'schedule', 'rescore'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Everything needed to explain and reproduce a run's computations. */
export interface RunConfigSnapshot {
  toolVersion: string;
  gitCommit?: string;
  sourcesConfigSha256: Sha256Hex;
  weightsVersion: string;
  weightsSha256: Sha256Hex;
  /** e.g. `{ exclusion: 'exclusion.v1', cashout: 'cashout.v1' }` */
  rulesVersions: Record<string, string>;
  /**
   * The model server of the run: `baseUrl` without credentials or query, the model id, its digest (`none` when none is
   * configured) and whether suggestions were enabled.
   */
  llm?: { baseUrl: string; model: string; modelDigest?: string; enabled?: boolean };
  /**
   * Rescore runs: ids of the analyst overrides the run applies, fixed when it was queued (those recorded until then,
   * oldest first). Scoring and reports use exactly this set; `rulesVersions.overrides` labels it.
   */
  analystOverrides?: Id[];
}

/** One execution of a case analysis. Re-runs never modify earlier runs; they are diffed. */
export interface AnalysisRun {
  id: Id;
  caseId: Id;
  previousRunId?: Id;
  trigger: RunTrigger;
  /** For `rescore` runs: the run whose stored captures are re-processed without re-fetching. */
  rescoreOfRunId?: Id;
  mode: FetchMode;
  status: RunStatus;
  config: RunConfigSnapshot;
  queuedAt: IsoDateTime;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
}
