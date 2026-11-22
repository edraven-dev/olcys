/**
 * Access log: who viewed or exported which case, and why (purpose limitation). Append-only, kept apart from the
 * evidence it refers to. Facts about use of the tool, never part of a score.
 */
import type { Id, IsoDateTime } from './common.ts';

export const ACCESS_ACTIONS = [
  'case.view',
  'run.view',
  'evidence.view',
  'report.view',
  'export.download',
  'audit.view',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACCESS_OUTCOMES = ['ok', 'denied', 'failed'] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

export interface AccessLogEntry {
  id: Id;
  at: IsoDateTime;
  /** The analyst identity of the API (never taken from a request). */
  actor: string;
  action: AccessAction;
  caseId?: Id;
  runId?: Id;
  /** What was read: the route pattern, or the export format / blob digest. */
  resource?: string;
  /** Stated purpose of the access: the `X-Olcys-Purpose` request header, else the purpose recorded with the case. */
  purpose?: string;
  outcome: AccessOutcome;
  ip: string;
}

export interface AccessLogQuery {
  caseId?: Id;
  actor?: string;
  /** At most this many entries (default 100, newest first). */
  limit?: number;
}

/** Append-only: the application role may only insert and read. */
export interface AccessLogRepository {
  add(entry: AccessLogEntry): Promise<void>;
  /** Newest first, by (`at`, `id`). */
  list(query?: AccessLogQuery): Promise<AccessLogEntry[]>;
}
