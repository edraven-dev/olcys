/**
 * Repository ports. The pipeline and the API depend only on these interfaces; the SQL implementations live in
 * `@olcys/db` (`createSqlRepositories`) and are wired in the composition root. Evidence repositories are
 * append-only: they add and read, never update or delete.
 */
import type { ActivityIndicators, CashOutEvent } from './analytics.ts';
import type { AnalysisRun, Case, CaseSchedule, Identifier } from './case.ts';
import type { ChangeEvent } from './changes.ts';
import type { NormalizedTransfer } from './chain-data.ts';
import type { AddressRef } from './chains.ts';
import type { Id, IsoDateTime } from './common.ts';
import type { Capture, CustodyEvent, Observation, OnlineAccount } from './evidence.ts';
import type { AddressCandidate, ExtractionResult } from './extraction.ts';
import type { AddressLabel, ExclusionDecision } from './labels.ts';
import type { EgressLogEntry, ProvenanceEnvelope } from './provenance.ts';
import type { CaseScheduleChange, ScheduleTick, ScheduleTickOutcome } from './schedule.ts';
import type { CreateCaseInput } from './schemas.ts';
import type { AnalystJudgement, AnalystOverride, LinkAssessment } from './scoring.ts';

export interface CaseWithIdentifiers extends Case {
  identifiers: Identifier[];
}

export interface RunWithProgress extends AnalysisRun {
  /** Per-step progress for the UI, e.g. `{ step: 'collect.source', done: 3, total: 5 }`. */
  progress: Record<string, unknown>;
  error?: string;
}

export interface RunPatch {
  status?: AnalysisRun['status'];
  progress?: Record<string, unknown>;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string;
}

export interface CaseRepository {
  create(input: CreateCaseInput, createdBy: string): Promise<CaseWithIdentifiers>;
  get(id: Id): Promise<CaseWithIdentifiers | undefined>;
  list(): Promise<Case[]>;
}

export interface RunRepository {
  create(run: AnalysisRun): Promise<void>;
  /** Only lifecycle fields are mutable (status, progress, error, timestamps). */
  update(id: Id, patch: RunPatch): Promise<void>;
  get(id: Id): Promise<RunWithProgress | undefined>;
  listByCase(caseId: Id): Promise<RunWithProgress[]>;
  /** Latest `succeeded` or `partial` run of the case. */
  latestCompleted(caseId: Id, excludeRunId?: Id): Promise<RunWithProgress | undefined>;
}

// --- scheduling ------------------------------------------------------------------------------------------------

/** An open case with an enabled schedule, as the scheduler evaluates it. */
export interface ActiveSchedule {
  caseId: Id;
  schedule: CaseSchedule;
  /** When the current schedule was set (the latest change; the case's creation when no change is recorded). */
  changedAt: IsoDateTime;
  /** The occurrence handled by the case's latest tick. */
  lastScheduledFor?: IsoDateTime;
}

/** What a tick decision sees, read while the case's schedule lock is held (schedule changes take the same lock). */
export interface ScheduleTickContext {
  case: Case;
  /** When the current schedule was set (the latest change; the case's creation when no change is recorded). */
  changedAt: IsoDateTime;
  /** The latest occurrence already handled for the case. */
  lastScheduledFor?: IsoDateTime;
  /** Runs of the case that are `queued` or `running`. */
  activeRunIds: Id[];
  /** Latest `succeeded` or `partial` run of the case, any trigger. */
  previousRunId?: Id;
}

export type ScheduleTickDecision =
  | { outcome: Exclude<ScheduleTickOutcome, 'started'> }
  | { outcome: 'started'; run: AnalysisRun }
  /**
   * Not due for the current schedule — it changed after the occurrence was picked, a later occurrence was handled, or
   * this is not (yet) an occurrence of its cron: nothing is recorded.
   */
  | { outcome: 'not_due' };

export type ScheduleChangeResult =
  | { ok: true; change: CaseScheduleChange }
  | { ok: false; error: 'case_not_found' | 'case_closed' };

/** Schedules, their change log and ticks. Changes and ticks are append-only; only `cases.schedule` is replaced. */
export interface ScheduleRepository {
  /**
   * Replaces the schedule of an open case and records the change (who, why, before, after) atomically, under the same
   * per-case lock as `fire`, so a tick decision never interleaves with a change.
   */
  setSchedule(
    caseId: Id,
    schedule: CaseSchedule,
    change: { changedBy: string; reason: string; at: IsoDateTime },
  ): Promise<ScheduleChangeResult>;
  /** Newest first. */
  listChanges(caseId: Id, limit: number): Promise<CaseScheduleChange[]>;
  /** Newest occurrence first. */
  listTicks(caseId: Id, limit: number): Promise<ScheduleTick[]>;
  /** Open cases with an enabled schedule. */
  listActive(): Promise<ActiveSchedule[]>;
  /**
   * Handles one occurrence at most once. Serialised per case, also across processes. When `claim.jobId` already has a
   * tick, returns it with `claimed: false` and decides nothing. Otherwise `decide` runs with the current state of the
   * case, and its tick — with the run it starts, if any — is stored atomically (`claimed: true`). A `not_due` decision
   * stores nothing and returns no tick.
   */
  fire(
    claim: Pick<ScheduleTick, 'caseId' | 'jobId' | 'scheduledFor' | 'firedAt'>,
    decide: (context: ScheduleTickContext) => ScheduleTickDecision,
  ): Promise<{ tick?: ScheduleTick; claimed: boolean }>;
}

/** Collection and extraction artefacts. */
export interface EvidenceRepository {
  addEgressLog(entries: EgressLogEntry[]): Promise<void>;
  addRawFetches(envelopes: ProvenanceEnvelope[]): Promise<void>;
  addCaptures(captures: Capture[]): Promise<void>;
  addAccounts(accounts: OnlineAccount[]): Promise<void>;
  addObservations(observations: Observation[]): Promise<void>;
  /** Stores the result, its candidates and secret positions (never secret values). */
  addExtraction(runId: Id, result: ExtractionResult): Promise<void>;
  listEgressLog(runId: Id): Promise<EgressLogEntry[]>;
  listCaptures(runId: Id): Promise<Capture[]>;
  getCapture(id: Id): Promise<Capture | undefined>;
  listAccounts(runId: Id): Promise<OnlineAccount[]>;
  listObservations(runId: Id): Promise<Observation[]>;
  listExtractionResults(runId: Id): Promise<ExtractionResult[]>;
  listCandidates(runId: Id): Promise<AddressCandidate[]>;
}

export interface ChainDataRepository {
  addTransfers(runId: Id, address: AddressRef, transfers: NormalizedTransfer[]): Promise<void>;
  listTransfers(runId: Id): Promise<NormalizedTransfer[]>;
}

/** Computed results of a run. */
export interface AnalysisRepository {
  addExclusions(decisions: ExclusionDecision[]): Promise<void>;
  addActivity(runId: Id, indicators: ActivityIndicators[]): Promise<void>;
  addCashOuts(events: CashOutEvent[]): Promise<void>;
  addLinks(links: LinkAssessment[]): Promise<void>;
  addChanges(changes: ChangeEvent[]): Promise<void>;
  addReport(report: { runId: Id; kind: string; blobSha256: string; mediaType: string }): Promise<void>;
  listExclusions(runId: Id): Promise<ExclusionDecision[]>;
  listActivity(runId: Id): Promise<ActivityIndicators[]>;
  listCashOuts(runId: Id): Promise<CashOutEvent[]>;
  listLinks(runId: Id): Promise<LinkAssessment[]>;
  /** One stored assessment, whatever run it belongs to. */
  getLink?(id: Id): Promise<LinkAssessment | undefined>;
  listChanges(runId: Id): Promise<ChangeEvent[]>;
  latestReport(
    runId: Id,
    kind: string,
  ): Promise<{ blobSha256: string; mediaType: string; createdAt: string } | undefined>;
}

/** Reference data (labels are not run-scoped); re-importing the same dataset row is a no-op. */
export interface LabelRepository {
  upsert(labels: AddressLabel[]): Promise<void>;
  list(): Promise<AddressLabel[]>;
}

/**
 * Analyst statements about links, recorded next to the computed assessment (append-only: added and read, never
 * updated or deleted). Lists are ordered oldest first by (`at`, `id`).
 */
export interface JudgementRepository {
  add(judgement: AnalystJudgement): Promise<void>;
  listByLink(linkAssessmentId: Id): Promise<AnalystJudgement[]>;
  /** Judgements on the links of one run. */
  listByRun(runId: Id): Promise<AnalystJudgement[]>;
}

/**
 * Analyst inputs to a case's evidence (append-only). They take effect only in a later rescore run. Lists are ordered
 * oldest first by (`at`, `id`).
 */
export interface OverrideRepository {
  add(override: AnalystOverride): Promise<void>;
  listByCase(caseId: Id): Promise<AnalystOverride[]>;
}

/**
 * Chain-of-custody events (append-only: added and read, never updated or deleted). Lists are ordered oldest first by
 * (`at`, `id`).
 */
export interface CustodyRepository {
  add(events: CustodyEvent[]): Promise<void>;
  listBySubjects(subjectIds: Id[]): Promise<CustodyEvent[]>;
}

export interface Repositories {
  cases: CaseRepository;
  runs: RunRepository;
  evidence: EvidenceRepository;
  chain: ChainDataRepository;
  analysis: AnalysisRepository;
  labels: LabelRepository;
  /** Periodic re-runs (both `@olcys/db` implementations provide it; `ApiMeta.features.schedules`). */
  schedules?: ScheduleRepository;
  /** Present when the store keeps analyst judgements (`ApiMeta.features.judgements`). */
  judgements?: JudgementRepository;
  /** Present when the store keeps analyst overrides. */
  overrides?: OverrideRepository;
  /** Present when the store keeps chain-of-custody events. */
  custody?: CustodyRepository;
}
