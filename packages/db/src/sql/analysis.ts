import { createHash } from 'node:crypto';
import type { AddressLabel, AnalysisRepository, ChainDataRepository, LabelRepository } from '@olcys/core';
import { canonicalJson, uniqueTransfers } from '@olcys/core';
import { json, type Db } from '../client.ts';

/** Content identity of a label: everything except the import-specific id and retrieval time. */
export function labelContentSha256(label: AddressLabel): string {
  const { datasetId, url, license, lastmod } = label.provenance;
  const content = {
    address: label.address,
    entity: label.entity,
    category: label.category,
    attributes: label.attributes,
    confidence: label.confidence,
    provenance: { datasetId, url, license, lastmod },
  };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function sqlChainDataRepository(db: Db): ChainDataRepository {
  return {
    async addTransfers(runId, address, transfers) {
      if (!transfers.length) return;
      await db
        .insertInto('chain_transfers')
        .values(
          transfers.map((t) => ({
            run_id: runId,
            chain: address.chain,
            address: address.address,
            tx_hash: t.txHash,
            record: json(t),
          })),
        )
        .execute();
    },

    async listTransfers(runId) {
      const rows = await db.selectFrom('chain_transfers').select('record').where('run_id', '=', runId).execute();
      // A transfer between two analysed addresses is stored under both; the run has it once.
      return uniqueTransfers(rows.map((r) => r.record));
    },
  };
}

export function sqlAnalysisRepository(db: Db): AnalysisRepository {
  return {
    async addExclusions(decisions) {
      if (!decisions.length) return;
      await db
        .insertInto('exclusion_decisions')
        .values(
          decisions.map((d) => ({
            id: d.id,
            run_id: d.runId,
            chain: d.address.chain,
            address: d.address.address,
            rule_id: d.ruleId,
            outcome: d.outcome,
            record: json(d),
          })),
        )
        .execute();
    },

    async addActivity(runId, indicators) {
      if (!indicators.length) return;
      await db
        .insertInto('activity')
        .values(
          indicators.map((a) => ({
            run_id: runId,
            chain: a.address.chain,
            address: a.address.address,
            record: json(a),
          })),
        )
        .execute();
    },

    async addCashOuts(events) {
      if (!events.length) return;
      await db
        .insertInto('cash_out_events')
        .values(
          events.map((e) => ({
            id: e.id,
            run_id: e.runId,
            chain: e.address.chain,
            address: e.address.address,
            rule_id: e.ruleId,
            record: json(e),
          })),
        )
        .execute();
    },

    async addLinks(links) {
      if (!links.length) return;
      await db
        .insertInto('link_assessments')
        .values(
          links.map((l) => ({
            id: l.id,
            run_id: l.runId,
            identity_id: l.identityId,
            chain: l.address.chain,
            address: l.address.address,
            relation: l.relation,
            tier: l.tier,
            score: l.score,
            record: json(l),
          })),
        )
        .execute();
    },

    async addChanges(changes) {
      if (!changes.length) return;
      await db
        .insertInto('change_events')
        .values(
          changes.map((c) => ({
            id: c.id,
            run_id: c.runId,
            previous_run_id: c.previousRunId,
            kind: c.kind,
            record: json(c),
          })),
        )
        .execute();
    },

    async addReport(report) {
      await db
        .insertInto('reports')
        .values({
          run_id: report.runId,
          kind: report.kind,
          blob_sha256: report.blobSha256,
          media_type: report.mediaType,
        })
        .execute();
    },

    async listExclusions(runId) {
      return (await db.selectFrom('exclusion_decisions').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async listActivity(runId) {
      return (await db.selectFrom('activity').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async listCashOuts(runId) {
      return (await db.selectFrom('cash_out_events').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async listLinks(runId) {
      return (
        await db
          .selectFrom('link_assessments')
          .select('record')
          .where('run_id', '=', runId)
          .orderBy('score', 'desc')
          .execute()
      ).map((r) => r.record);
    },

    async getLink(id) {
      const row = await db.selectFrom('link_assessments').select('record').where('id', '=', id).executeTakeFirst();
      return row?.record;
    },

    async listChanges(runId) {
      return (await db.selectFrom('change_events').select('record').where('run_id', '=', runId).execute()).map(
        (r) => r.record,
      );
    },

    async latestReport(runId, kind) {
      const row = await db
        .selectFrom('reports')
        .select(['blob_sha256', 'media_type', 'created_at'])
        .where('run_id', '=', runId)
        .where('kind', '=', kind)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row
        ? { blobSha256: row.blob_sha256, mediaType: row.media_type, createdAt: row.created_at.toISOString() }
        : undefined;
    },
  };
}

export function sqlLabelRepository(db: Db): LabelRepository {
  return {
    async upsert(labels) {
      if (!labels.length) return;
      await db
        .insertInto('address_labels')
        .values(
          labels.map((l) => ({
            chain: l.address.chain,
            address: l.address.address,
            entity: l.entity,
            category: l.category,
            dataset: l.provenance.datasetId,
            lastmod: l.provenance.lastmod,
            record_sha256: labelContentSha256(l),
            record: json(l),
          })),
        )
        // Exact re-imports are no-ops; a corrected record is a new row (append-only) and becomes current.
        .onConflict((oc) => oc.columns(['chain', 'address', 'entity', 'dataset', 'record_sha256']).doNothing())
        .execute();
    },

    /** Current labels: the newest dataset version per (chain, address, entity, dataset). */
    async list() {
      const rows = await db
        .selectFrom('address_labels')
        .distinctOn(['chain', 'address', 'entity', 'dataset'])
        .select('record')
        .orderBy('chain')
        .orderBy('address')
        .orderBy('entity')
        .orderBy('dataset')
        .orderBy('lastmod', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map((r) => r.record);
    },
  };
}
