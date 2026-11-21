import type { AnalysisRun, RunRepository, RunWithProgress } from '@olcys/core';
import { iso, json, type Db } from '../client.ts';

interface RunRow {
  id: string;
  case_id: string;
  previous_run_id: string | null;
  trigger: AnalysisRun['trigger'];
  mode: AnalysisRun['mode'];
  status: AnalysisRun['status'];
  config: AnalysisRun['config'];
  progress: Record<string, unknown>;
  error: string | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toRun(row: RunRow): RunWithProgress {
  const startedAt = iso(row.started_at);
  const finishedAt = iso(row.finished_at);
  return {
    id: row.id,
    caseId: row.case_id,
    ...(row.previous_run_id ? { previousRunId: row.previous_run_id } : {}),
    trigger: row.trigger,
    mode: row.mode,
    status: row.status,
    config: row.config,
    queuedAt: row.queued_at.toISOString(),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    progress: row.progress,
    ...(row.error ? { error: row.error } : {}),
  };
}

export function sqlRunRepository(db: Db): RunRepository {
  return {
    async create(run) {
      await db
        .insertInto('runs')
        .values({
          id: run.id,
          case_id: run.caseId,
          previous_run_id: run.previousRunId ?? null,
          trigger: run.trigger,
          mode: run.mode,
          status: run.status,
          config: json(run.config),
          queued_at: run.queuedAt,
        })
        .execute();
    },

    async update(id, patch) {
      await db
        .updateTable('runs')
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.progress ? { progress: json(patch.progress) } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.startedAt ? { started_at: patch.startedAt } : {}),
          ...(patch.finishedAt ? { finished_at: patch.finishedAt } : {}),
        })
        .where('id', '=', id)
        .execute();
    },

    async get(id) {
      const row = await db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? toRun(row) : undefined;
    },

    async listByCase(caseId) {
      const rows = await db
        .selectFrom('runs')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('queued_at', 'desc')
        .execute();
      return rows.map(toRun);
    },

    async latestCompleted(caseId, excludeRunId) {
      let query = db
        .selectFrom('runs')
        .selectAll()
        .where('case_id', '=', caseId)
        .where('status', 'in', ['succeeded', 'partial']);
      if (excludeRunId) query = query.where('id', '!=', excludeRunId);
      const row = await query.orderBy('queued_at', 'desc').executeTakeFirst();
      return row ? toRun(row) : undefined;
    },
  };
}
