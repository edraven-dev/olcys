/**
 * Fund-flow query on PostgreSQL: the address-level breadth-first walk of `walkFlows` (`@olcys/core`, shared with the
 * in-memory store, so both have the same semantics) with one parameterised query per hop over the stored transfers of
 * a run. One entry per address and hop keeps the work linear in the transfers: parallel transfers of a leg are rows of
 * one hop, never multiplied into paths. Raw SQL on purpose (`unnest` of the frontier joined to the transfers).
 */
import type { FlowQuery, FlowQueryResult, Id, NormalizedTransfer } from '@olcys/core';
import { flowAddress, walkFlows } from '@olcys/core';
import { sql } from 'kysely';
import type { Db } from './client.ts';

interface Row {
  record: NormalizedTransfer;
}

export function queryFlowEdges(db: Db, query: FlowQuery & { runId: Id }): Promise<FlowQueryResult> {
  const out = query.direction === 'out';
  // Column names and operators are fixed strings chosen here, never input.
  const entry = sql.raw(out ? 'x.f' : 'x.t');
  const later = sql.raw(out ? '>=' : '<=');
  // Derived co-spend rows start and continue downstream paths only.
  const original = sql.raw(out ? 'TRUE' : "(x.record->>'derivedFrom') IS NULL");
  return walkFlows(
    async (frontier, limit) => {
      const addresses = frontier.map((i) => i.address);
      const times = frontier.map((i) => i.at ?? null);
      const result = await sql<Row>`
        WITH fr AS (SELECT u.a, u.t FROM unnest(${addresses}::text[], ${times}::timestamptz[]) AS u(a, t))
        SELECT d.record
          FROM (
            SELECT DISTINCT ON (x.chain, x.record->>'txHash', x.record->>'index', x.record->>'kind', x.f, x.t,
                                x.record->'asset'->>'symbol', x.record->'asset'->>'contract', x.record->>'amount')
                   x.record, x.f, x.t, x.bt
              FROM (
                SELECT id, chain, record,
                       CASE WHEN chain LIKE 'evm:%' THEN lower(record->>'from') ELSE record->>'from' END AS f,
                       CASE WHEN chain LIKE 'evm:%' THEN lower(record->>'to') ELSE record->>'to' END AS t,
                       (record->>'blockTime')::timestamptz AS bt
                  FROM olcys.chain_transfers
                 WHERE run_id = ${query.runId} AND chain = ${query.chain}
              ) x
              JOIN fr ON ${entry} = fr.a AND (fr.t IS NULL OR x.bt ${later} fr.t)
             WHERE x.f <> x.t AND ${original}
             ORDER BY x.chain, x.record->>'txHash', x.record->>'index', x.record->>'kind', x.f, x.t,
                      x.record->'asset'->>'symbol', x.record->'asset'->>'contract', x.record->>'amount', x.id
          ) d
         ORDER BY d.bt, (d.record->>'txHash') COLLATE "C", coalesce((d.record->>'index')::int, -1),
                  d.f COLLATE "C", d.t COLLATE "C", (d.record->>'amount') COLLATE "C"
         LIMIT ${limit}
      `.execute(db);
      return result.rows.map((r) => r.record);
    },
    {
      ...query,
      seeds: query.seeds.map((a) => flowAddress(query.chain, a)),
      stopAt: query.stopAt.map((a) => flowAddress(query.chain, a)),
    },
  );
}
