import type { AddressCluster, ClusterRepository } from '@olcys/core';
import { sql, type Selectable } from 'kysely';
import { json, type Db } from '../client.ts';
import type { Database } from '../schema.ts';

type Row = Selectable<Database['address_cluster']>;

function fromRow(r: Row, runId: string): AddressCluster {
  const c: AddressCluster = {
    id: r.id,
    runId,
    chain: r.chain as AddressCluster['chain'],
    heuristic: r.heuristic,
    algorithmVersion: r.algorithm_version,
    seeds: r.seeds,
    members: r.members,
    size: r.size,
    mergeEvidence: r.merge_evidence,
    skipped: r.skipped,
    serviceMembers: r.service_members,
    flags: r.flags,
  };
  if (r.previous_size !== null) c.previousSize = r.previous_size;
  return c;
}

/** PostgreSQL co-spend clusters (append-only; unique per run and cluster id). */
export function sqlClusterRepository(db: Db): ClusterRepository {
  return {
    async add(runId, clusters) {
      if (!clusters.length) return;
      await db
        .insertInto('address_cluster')
        .values(
          clusters.map((c) => ({
            run_id: runId,
            id: c.id,
            chain: c.chain,
            heuristic: c.heuristic,
            algorithm_version: c.algorithmVersion,
            seeds: c.seeds,
            members: c.members,
            size: c.size,
            previous_size: c.previousSize ?? null,
            merge_evidence: json(c.mergeEvidence),
            skipped: json(c.skipped),
            service_members: json(c.serviceMembers),
            flags: json(c.flags),
          })),
        )
        .execute();
    },

    async list(runId) {
      const rows = await db
        .selectFrom('address_cluster')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy(sql`id collate "C"`)
        .execute();
      return rows.map((r) => fromRow(r, runId));
    },

    async previousSizes(caseId, seeds, beforeRunId) {
      const sizes = new Map<string, number>();
      if (!seeds.length) return sizes;
      // The newest earlier run of the case wins per seed (ties by run id, which is time-ordered).
      const rows = await db
        .selectFrom('address_cluster as c')
        .innerJoin('runs as r', 'r.id', 'c.run_id')
        .innerJoin('runs as cur', (join) => join.on('cur.id', '=', beforeRunId))
        .select(['c.seeds', 'c.size', 'r.queued_at', 'r.id as run'])
        .where('r.case_id', '=', caseId)
        .where('r.id', '<>', beforeRunId)
        .whereRef('r.queued_at', '<', 'cur.queued_at')
        .where(sql<boolean>`c.seeds && ${seeds}::text[]`)
        .orderBy('r.queued_at', 'asc')
        .orderBy('r.id', 'asc')
        .execute();
      // Ascending, so a later run overwrites an earlier one.
      for (const row of rows) for (const seed of row.seeds) if (seeds.includes(seed)) sizes.set(seed, row.size);
      return sizes;
    },
  };
}
