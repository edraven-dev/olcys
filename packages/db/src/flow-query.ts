/**
 * Fund-flow query on PostgreSQL: a recursive CTE over the stored transfers of a run with `SEARCH BREADTH FIRST` and
 * `CYCLE` detection (PostgreSQL 14+). Semantics are those of `traceFlows` in `@olcys/core` (the in-memory store):
 * time-monotonic paths, stop addresses, bounded hops, one row per transfer at its smallest |hop|, ordered and cut at
 * `limit` (`truncated`). Raw SQL on purpose: the Kysely builder has no recursive CTE with SEARCH/CYCLE.
 */
import type { FlowQuery, FlowQueryResult, FlowRow, Id, NormalizedTransfer } from '@olcys/core';
import { flowAddress } from '@olcys/core';
import { sql } from 'kysely';
import type { Db } from './client.ts';

interface Row {
  record: NormalizedTransfer;
  hop: number;
  is_cycle: boolean;
}

export async function queryFlowEdges(db: Db, query: FlowQuery & { runId: Id }): Promise<FlowQueryResult> {
  const out = query.direction === 'out';
  const seeds = query.seeds.map((a) => flowAddress(query.chain, a));
  const stop = query.stopAt.map((a) => flowAddress(query.chain, a));
  // Column names and operators are fixed strings chosen here, never input.
  const entry = sql.raw(out ? 'f' : 't');
  const exit = sql.raw(out ? 't' : 'f');
  const later = sql.raw(out ? '>=' : '<=');
  const first = sql.raw(out ? '1' : '-1');
  const step = sql.raw(out ? '+ 1' : '- 1');
  const within = out ? sql`fl.hop < ${query.maxHops}` : sql`fl.hop > ${-query.maxHops}`;
  const result = await sql<Row>`
    WITH RECURSIVE
    edges AS MATERIALIZED (
      SELECT DISTINCT ON (x.chain, x.record->>'txHash', x.record->>'index', x.record->>'kind', x.f, x.t,
                          x.record->'asset'->>'symbol', x.record->'asset'->>'contract', x.record->>'amount')
             x.id AS eid, x.record, x.f, x.t,
             (x.record->>'blockTime')::timestamptz AS bt
        FROM (
          SELECT id, chain, record,
                 CASE WHEN chain LIKE 'evm:%' THEN lower(record->>'from') ELSE record->>'from' END AS f,
                 CASE WHEN chain LIKE 'evm:%' THEN lower(record->>'to') ELSE record->>'to' END AS t
            FROM olcys.chain_transfers
           WHERE run_id = ${query.runId} AND chain = ${query.chain}
        ) x
       WHERE x.f <> x.t
       ORDER BY x.chain, x.record->>'txHash', x.record->>'index', x.record->>'kind', x.f, x.t,
                x.record->'asset'->>'symbol', x.record->'asset'->>'contract', x.record->>'amount', x.id
    ),
    flow AS (
      SELECT e.eid, e.f, e.t, e.bt, ${first} AS hop
        FROM edges e
       WHERE e.${entry} = ANY(${seeds}::text[])
      UNION ALL
      SELECT e.eid, e.f, e.t, e.bt, fl.hop ${step}
        FROM flow fl
        JOIN edges e ON e.${entry} = fl.${exit} AND e.bt ${later} fl.bt
       WHERE ${within}
         AND NOT (fl.${exit} = ANY(${stop}::text[]))
         AND NOT (fl.${exit} = ANY(${seeds}::text[]))
    ) SEARCH BREADTH FIRST BY ${exit} SET ord
      CYCLE ${exit} SET is_cycle USING path,
    reached AS (
      SELECT DISTINCT ON (fl.eid) fl.eid, fl.hop,
             bool_and(fl.is_cycle) OVER (PARTITION BY fl.eid, abs(fl.hop)) AS is_cycle
        FROM flow fl
       ORDER BY fl.eid, abs(fl.hop)
    )
    SELECT e.record, r.hop, r.is_cycle
      FROM reached r
      JOIN edges e ON e.eid = r.eid
     ORDER BY abs(r.hop), e.bt, (e.record->>'txHash') COLLATE "C", coalesce((e.record->>'index')::int, -1),
              e.f COLLATE "C", e.t COLLATE "C", (e.record->>'amount') COLLATE "C"
     LIMIT ${query.limit + 1}
  `.execute(db);
  const rows: FlowRow[] = [];
  for (const r of result.rows) rows.push(Object.assign({}, r.record, { hop: Number(r.hop), isCycle: r.is_cycle }));
  return { rows: rows.slice(0, query.limit), truncated: rows.length > query.limit };
}
