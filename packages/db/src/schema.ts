/**
 * Kysely table types for the `olcys` schema (see migrations/0001_init.sql).
 * JSONB columns are written as JSON strings and read back as parsed values.
 */
import type {
  AddressLabel,
  AddressType,
  AddressTypeClassification,
  AnalysisRun,
  CaseSchedule,
  CaseScope,
  Capture,
  CashOutEvent,
  ChangeEvent,
  EgressLogEntry,
  ExclusionDecision,
  ExtractionResult,
  LinkAssessment,
  NormalizedTransfer,
  OnlineAccount,
  ProvenanceEnvelope,
  ActivityIndicators,
  AddressCandidate,
  AnalystOverrideKind,
  AnalystOverrideTarget,
  ScheduleTickOutcome,
} from '@olcys/core';
import type { ColumnType, Generated } from 'kysely';

/** jsonb: parsed object on select, JSON string on insert. */
export type Json<T> = ColumnType<T, string, string>;
/** timestamptz: Date on select, Date or ISO string on insert/update. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface CasesTable {
  id: Generated<string>;
  title: string;
  purpose: string;
  legal_basis: string;
  status: ColumnType<'open' | 'closed', 'open' | 'closed' | undefined, 'open' | 'closed'>;
  scope: Json<CaseScope>;
  created_at: GeneratedTimestamp;
  created_by: string;
  /** Current schedule (migration 0002); the only column the application role may replace besides `status`. */
  schedule: ColumnType<CaseSchedule | null, string | null | undefined, string | null>;
}

/** Append-only log of schedule changes. */
export interface CaseScheduleChangeTable {
  id: Generated<string>;
  case_id: string;
  before: ColumnType<CaseSchedule | null, string | null, never>;
  after: ColumnType<CaseSchedule, string, never>;
  changed_by: string;
  reason: string;
  at: GeneratedTimestamp;
}

/** Append-only: one row per handled occurrence of a schedule. */
export interface ScheduleTickTable {
  id: Generated<string>;
  case_id: string;
  job_id: string;
  scheduled_for: Timestamp;
  fired_at: Timestamp;
  outcome: ScheduleTickOutcome;
  run_id: string | null;
  at: GeneratedTimestamp;
}

export interface CaseIdentifiersTable {
  id: Generated<string>;
  case_id: string;
  kind: string;
  value: string;
  platform: string | null;
  chain: string | null;
  is_anchor: boolean;
  added_at: GeneratedTimestamp;
  added_by: string;
}

export interface RunsTable {
  id: string;
  case_id: string;
  previous_run_id: string | null;
  rescore_of_run_id: string | null;
  trigger: AnalysisRun['trigger'];
  mode: AnalysisRun['mode'];
  status: AnalysisRun['status'];
  config: Json<AnalysisRun['config']>;
  progress: ColumnType<Record<string, unknown>, string | undefined, string>;
  error: string | null;
  queued_at: GeneratedTimestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

interface RunRecordTable<T> {
  id: string;
  run_id: string;
  record: Json<T>;
}

export interface EgressLogTable {
  id: string;
  run_id: string | null;
  at: Timestamp;
  entry: Json<EgressLogEntry>;
}

export interface RawFetchesTable {
  id: string;
  run_id: string | null;
  received_at: Timestamp;
  envelope: Json<ProvenanceEnvelope>;
}

export interface CapturesTable extends RunRecordTable<Capture> {
  source_id: string;
  url: string;
  final_url: string;
  status: string;
  collected_at: Timestamp;
  manifest_sha256: string;
}

export interface AccountsTable extends RunRecordTable<OnlineAccount> {
  platform: string;
  handle: string;
}

export interface ObservationsTable {
  id: string;
  run_id: string;
  capture_id: string;
  source_id: string;
  subject_type: string;
  subject_key: string;
  property: string;
  value: string;
  locator: string;
  observed_at: Timestamp;
}

export interface ExtractionResultsTable {
  id: Generated<string>;
  run_id: string;
  capture_id: string;
  record: Json<ExtractionResult>;
}

export interface AddressCandidatesTable extends RunRecordTable<AddressCandidate> {
  capture_id: string;
  chain: string;
  address: string;
}

export interface SecretFindingsTable {
  id: Generated<string>;
  run_id: string;
  capture_id: string;
  kind: string;
  view: string;
  span_start: number;
  span_end: number;
}

export interface ChainTransfersTable {
  id: Generated<string>;
  run_id: string;
  chain: string;
  address: string;
  tx_hash: string;
  record: Json<NormalizedTransfer>;
}

export interface AddressLabelsTable {
  id: Generated<string>;
  chain: string;
  address: string;
  entity: string;
  category: string;
  dataset: string;
  lastmod: Timestamp;
  record_sha256: string;
  record: Json<AddressLabel>;
}

export interface ExclusionDecisionsTable extends RunRecordTable<ExclusionDecision> {
  chain: string;
  address: string;
  rule_id: string;
  outcome: string;
}

/** Append-only: one address-type classification per run and address (migration 0004). */
export interface AddressTypeClassificationTable {
  id: Generated<string>;
  run_id: string;
  chain: string;
  address: string;
  type: AddressType;
  code_prefix: string | null;
  code_size: number | null;
  delegate: string | null;
  safe_master_copy: string | null;
  entry_point: string | null;
  implementation: string | null;
  script_type: AddressTypeClassification['scriptType'] | null;
  failed_probe: ColumnType<AddressTypeClassification['failedProbe'] | null, string | null, never>;
  fetch_ids: string[];
  created_at: GeneratedTimestamp;
}

export interface ActivityTable {
  id: Generated<string>;
  run_id: string;
  chain: string;
  address: string;
  record: Json<ActivityIndicators>;
}

export interface CashOutEventsTable extends RunRecordTable<CashOutEvent> {
  chain: string;
  address: string;
  rule_id: string;
}

export interface LinkAssessmentsTable extends RunRecordTable<LinkAssessment> {
  identity_id: string;
  chain: string;
  address: string;
  relation: string;
  tier: string;
  score: number;
}

export interface AnalystJudgementsTable {
  id: Generated<string>;
  link_assessment_id: string;
  judgement: 'same' | 'not_same' | 'unsure';
  justification: string;
  analyst: string;
  at: GeneratedTimestamp;
}

/** migrations/0003_analyst_overrides.sql */
export interface AnalystOverridesTable {
  id: string;
  case_id: string;
  kind: AnalystOverrideKind;
  target: Json<AnalystOverrideTarget>;
  value: string;
  justification: string;
  analyst: string;
  at: Timestamp;
}

export interface ChangeEventsTable extends RunRecordTable<ChangeEvent> {
  previous_run_id: string;
  kind: string;
}

export interface ReportsTable {
  id: Generated<string>;
  run_id: string;
  kind: string;
  blob_sha256: string;
  media_type: string;
  created_at: GeneratedTimestamp;
}

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  sha256: string;
  applied_at: GeneratedTimestamp;
}

export interface Database {
  cases: CasesTable;
  case_schedule_change: CaseScheduleChangeTable;
  schedule_tick: ScheduleTickTable;
  case_identifiers: CaseIdentifiersTable;
  runs: RunsTable;
  egress_log: EgressLogTable;
  raw_fetches: RawFetchesTable;
  captures: CapturesTable;
  accounts: AccountsTable;
  observations: ObservationsTable;
  extraction_results: ExtractionResultsTable;
  address_candidates: AddressCandidatesTable;
  secret_findings: SecretFindingsTable;
  chain_transfers: ChainTransfersTable;
  address_labels: AddressLabelsTable;
  exclusion_decisions: ExclusionDecisionsTable;
  address_type_classification: AddressTypeClassificationTable;
  activity: ActivityTable;
  cash_out_events: CashOutEventsTable;
  link_assessments: LinkAssessmentsTable;
  analyst_judgements: AnalystJudgementsTable;
  analyst_overrides: AnalystOverridesTable;
  change_events: ChangeEventsTable;
  reports: ReportsTable;
  schema_migrations: SchemaMigrationsTable;
}
