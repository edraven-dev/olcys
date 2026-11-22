/**
 * Repository ports. The pipeline and the API depend only on these interfaces; the SQL implementations live in
 * `@olcys/db` (`createSqlRepositories`) and are wired in the composition root. Evidence repositories are
 * append-only: they add and read, never update or delete.
 */
import type { ActivityIndicators, CashOutEvent } from './analytics.ts';
import type { AnalysisRun, Case, Identifier } from './case.ts';
import type { ChangeEvent } from './changes.ts';
import type { NormalizedTransfer } from './chain-data.ts';
import type { AddressRef } from './chains.ts';
import type { Id } from './common.ts';
import type { Capture, Observation, OnlineAccount } from './evidence.ts';
import type { AddressCandidate, ExtractionResult } from './extraction.ts';
import type { AddressLabel, ExclusionDecision } from './labels.ts';
import type { EgressLogEntry, ProvenanceEnvelope } from './provenance.ts';
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

export interface Repositories {
  cases: CaseRepository;
  runs: RunRepository;
  evidence: EvidenceRepository;
  chain: ChainDataRepository;
  analysis: AnalysisRepository;
  labels: LabelRepository;
  /** Present when the store keeps analyst judgements (`ApiMeta.features.judgements`). */
  judgements?: JudgementRepository;
  /** Present when the store keeps analyst overrides. */
  overrides?: OverrideRepository;
}
