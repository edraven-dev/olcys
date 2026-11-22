import type { EvidenceRepository, Observation } from '@olcys/core';
import { json, type Db } from '../client.ts';
import { insertCustodyEvents } from './custody.ts';
import { attachTimestamps } from './timestamps.ts';

export function sqlEvidenceRepository(db: Db): EvidenceRepository {
  return {
    async addEgressLog(entries) {
      if (!entries.length) return;
      await db
        .insertInto('egress_log')
        .values(entries.map((e) => ({ id: e.id, run_id: e.runId ?? null, at: e.at, entry: json(e) })))
        .execute();
    },

    async addRawFetches(envelopes) {
      if (!envelopes.length) return;
      await db
        .insertInto('raw_fetches')
        .values(
          envelopes.map((e) => ({
            id: e.fetchId,
            run_id: e.runId ?? null,
            received_at: e.receivedAt,
            envelope: json(e),
          })),
        )
        .execute();
    },

    async addCaptures(captures, custodyEvents) {
      if (!captures.length && !custodyEvents?.length) return;
      await db.transaction().execute(async (trx) => {
        if (captures.length) {
          await trx
            .insertInto('captures')
            .values(
              captures.map((c) => ({
                id: c.id,
                run_id: c.runId,
                source_id: c.sourceId,
                url: c.url,
                final_url: c.finalUrl,
                status: c.status,
                collected_at: c.collectedAt,
                manifest_sha256: c.manifestSha256,
                record: json(c),
              })),
            )
            .execute();
        }
        await insertCustodyEvents(trx, custodyEvents ?? []);
      });
    },

    async addAccounts(accounts) {
      if (!accounts.length) return;
      await db
        .insertInto('accounts')
        .values(
          accounts.map((a) => ({ id: a.id, run_id: a.runId, platform: a.platform, handle: a.handle, record: json(a) })),
        )
        .execute();
    },

    async addObservations(observations) {
      if (!observations.length) return;
      await db
        .insertInto('observations')
        .values(
          observations.map((o) => ({
            id: o.id,
            run_id: o.runId,
            capture_id: o.captureId,
            source_id: o.sourceId,
            subject_type: o.subject.type,
            subject_key: o.subject.key,
            property: o.property,
            value: o.value,
            locator: o.locator,
            observed_at: o.observedAt,
          })),
        )
        .execute();
    },

    async addExtraction(runId, result) {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('extraction_results')
          .values({ run_id: runId, capture_id: result.captureId, record: json(result) })
          .execute();
        if (result.candidates.length) {
          await trx
            .insertInto('address_candidates')
            .values(
              result.candidates.map((c) => ({
                id: c.id,
                run_id: runId,
                capture_id: c.captureId,
                chain: c.address.chain,
                address: c.address.address,
                record: json(c),
              })),
            )
            .execute();
        }
        if (result.secrets.length) {
          await trx
            .insertInto('secret_findings')
            .values(
              result.secrets.map((s) => ({
                run_id: runId,
                capture_id: result.captureId,
                kind: s.kind,
                view: s.view,
                span_start: s.span.start,
                span_end: s.span.end,
              })),
            )
            .execute();
        }
      });
    },

    async listEgressLog(runId) {
      return (
        await db.selectFrom('egress_log').select('entry').where('run_id', '=', runId).orderBy('at').execute()
      ).map((r) => r.entry);
    },

    async listCaptures(runId) {
      const rows = await db.selectFrom('captures').select('record').where('run_id', '=', runId).execute();
      return attachTimestamps(
        db,
        rows.map((r) => r.record),
      );
    },

    async getCapture(id) {
      const row = await db.selectFrom('captures').select('record').where('id', '=', id).executeTakeFirst();
      return row ? (await attachTimestamps(db, [row.record]))[0] : undefined;
    },

    async listAccounts(runId) {
      return (await db.selectFrom('accounts').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async listObservations(runId) {
      const rows = await db
        .selectFrom('observations')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('observed_at')
        .execute();
      return rows.map((r): Observation => ({
        id: r.id,
        runId: r.run_id,
        captureId: r.capture_id,
        sourceId: r.source_id,
        subject: { type: r.subject_type as Observation['subject']['type'], key: r.subject_key },
        property: r.property,
        value: r.value,
        locator: r.locator,
        observedAt: r.observed_at.toISOString(),
      }));
    },

    async listExtractionResults(runId) {
      return (await db.selectFrom('extraction_results').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async listCandidates(runId) {
      return (await db.selectFrom('address_candidates').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },
  };
}
