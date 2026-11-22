/** Access log (append-only: the application role may only insert and read), newest first by (`at`, `id`). */
import type { AccessLogEntry, AccessLogRepository } from '@olcys/core';
import { iso, type Db } from '../client.ts';

export function sqlAccessLogRepository(db: Db): AccessLogRepository {
  return {
    async add(e) {
      await db
        .insertInto('access_log')
        .values({
          id: e.id,
          at: e.at,
          actor: e.actor,
          action: e.action,
          case_id: e.caseId ?? null,
          run_id: e.runId ?? null,
          resource: e.resource ?? null,
          purpose: e.purpose ?? null,
          outcome: e.outcome,
          ip: e.ip,
        })
        .execute();
    },

    async list(query = {}) {
      let q = db.selectFrom('access_log').selectAll();
      if (query.caseId !== undefined) q = q.where('case_id', '=', query.caseId);
      if (query.actor !== undefined) q = q.where('actor', '=', query.actor);
      const rows = await q
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit ?? 100)
        .execute();
      return rows.map((r): AccessLogEntry => {
        const e: AccessLogEntry = {
          id: r.id,
          at: iso(r.at) ?? '',
          actor: r.actor,
          action: r.action,
          outcome: r.outcome,
          ip: r.ip,
        };
        if (r.case_id !== null) e.caseId = r.case_id;
        if (r.run_id !== null) e.runId = r.run_id;
        if (r.resource !== null) e.resource = r.resource;
        if (r.purpose !== null) e.purpose = r.purpose;
        return e;
      });
    },
  };
}
