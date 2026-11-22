/** Chain-of-custody events (append-only: the application role may only insert and read), oldest first by (`at`, `id`). */
import type { CustodyEvent, CustodyRepository } from '@olcys/core';
import type { Kysely } from 'kysely';
import { json, type Db } from '../client.ts';
import type { Database } from '../schema.ts';

/** Inserts custody events through a database or an open transaction. */
export async function insertCustodyEvents(db: Kysely<Database>, events: CustodyEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db
    .insertInto('custody_event')
    .values(
      events.map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        action: e.action,
        subject_type: e.subject.type,
        subject_id: e.subject.id,
        run_id: e.runId ?? null,
        detail: json(e.detail),
      })),
    )
    .execute();
}

export function sqlCustodyRepository(db: Db): CustodyRepository {
  return {
    async add(events) {
      await insertCustodyEvents(db, events);
    },

    async listBySubjects(subjectIds) {
      if (subjectIds.length === 0) return [];
      const rows = await db
        .selectFrom('custody_event')
        .selectAll()
        .where('subject_id', 'in', subjectIds)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map((row): CustodyEvent => {
        const event: CustodyEvent = {
          id: row.id,
          at: row.at.toISOString(),
          actor: row.actor,
          action: row.action,
          subject: { type: row.subject_type, id: row.subject_id },
          detail: row.detail,
        };
        if (row.run_id) event.runId = row.run_id;
        return event;
      });
    },
  };
}
