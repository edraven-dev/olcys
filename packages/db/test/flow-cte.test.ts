/**
 * Fund-flow queries: the same scenarios on the in-memory store (`traceFlows`) and on PostgreSQL (recursive CTE with
 * SEARCH BREADTH FIRST and CYCLE; needs OLCYS_TEST_DATABASE_URL[_OWNER]): time-monotonic paths, cycles, stop addresses,
 * hop and edge limits, one row per transfer. Flow edges and views round-trip and are append-only. Synthetic data.
 */
import type {
  AnalysisRun,
  ChainId,
  FlowEdge,
  FlowQuery,
  FlowQueryResult,
  FundFlowView,
  NormalizedTransfer,
  Repositories,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

const CHAIN: ChainId = 'tron';
const ETH: ChainId = 'evm:1';
const day = (n: number, hour = 0): string => new Date(Date.UTC(2026, 0, 1 + n, hour)).toISOString();
let counter = 0;
function transfer(
  from: string,
  to: string,
  at: string,
  options: { chain?: ChainId; amount?: string; index?: number; tx?: string } = {},
): NormalizedTransfer {
  counter += 1;
  const chain = options.chain ?? CHAIN;
  return {
    chain,
    txHash: options.tx ?? `tx-${String(counter).padStart(5, '0')}`,
    ...(options.index === undefined ? {} : { index: options.index }),
    blockHeight: counter,
    blockTime: at,
    from,
    to,
    asset: { chain, symbol: 'USDT', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    amount: options.amount ?? '10',
    kind: 'token',
    fetchId: newId(),
  };
}
const query = (over: Partial<FlowQuery>): FlowQuery => ({
  chain: CHAIN,
  seeds: ['A'],
  direction: 'out',
  maxHops: 3,
  stopAt: [],
  limit: 2000,
  ...over,
});
const path = (r: FlowQueryResult) => r.rows.map((x) => `${x.from}>${x.to}@${x.hop}${x.isCycle ? 'c' : ''}`);

interface Store {
  name: string;
  /** A run with exactly these transfers (stored under their sender). */
  seed(transfers: NormalizedTransfer[]): Promise<(q: FlowQuery) => Promise<FlowQueryResult>>;
}

function scenarios(store: () => Store): void {
  it('follows funds downstream in time order and stops at cycles (cycle edge returned, not expanded)', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(1)),
      transfer('B', 'C', day(2)),
      transfer('C', 'B', day(3)),
      transfer('B', 'Z', day(4)),
    ]);
    // C→B closes a loop to B (already on the path): returned as a cycle, nothing follows it; B→Z is reached through B.
    expect(path(await run(query({ maxHops: 5 })))).toEqual(['A>B@1', 'B>C@2', 'B>Z@2', 'C>B@3c']);
  });

  it('expands an address again when a later hop reaches it earlier in time', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(10)),
      transfer('A', 'C', day(1)),
      transfer('C', 'B', day(2)),
      transfer('B', 'D', day(3)), // only reachable through A→C→B (B reached on day 2), not from A→B (day 10)
    ]);
    expect(path(await run(query({})))).toEqual(['A>C@1', 'A>B@1', 'C>B@2', 'B>D@3']);
  });

  it('keeps a cross edge (A→B, A→C, B→C) as an ordinary edge, not a cycle', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(1)),
      transfer('A', 'C', day(1)),
      transfer('B', 'C', day(2)),
    ]);
    expect(path(await run(query({})))).toEqual(['A>B@1', 'A>C@1', 'B>C@2']);
  });

  it('returns a transfer back to a seed without expanding the seed again', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(1)),
      transfer('B', 'A', day(2)),
      transfer('A', 'Z', day(3)),
    ]);
    // B→A is shown at hop 2 as a cycle back to the seed; A→Z stays the first-hop edge it is (A is not expanded again).
    expect(path(await run(query({})))).toEqual(['A>B@1', 'A>Z@1', 'B>A@2c']);
  });

  it('only follows paths that never go back in time', async () => {
    const run = await store().seed([
      transfer('B', 'C', day(1)), // older than A→B: not on A's path
      transfer('A', 'B', day(2)),
      transfer('B', 'D', day(2)), // same time: allowed
      transfer('B', 'E', day(3)),
    ]);
    expect(path(await run(query({})))).toEqual(['A>B@1', 'B>D@2', 'B>E@2']);
  });

  it('bounds the depth: A→B→C→D→E yields three edges with maxHops 3', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(1)),
      transfer('B', 'C', day(2)),
      transfer('C', 'D', day(3)),
      transfer('D', 'E', day(4)),
    ]);
    expect(path(await run(query({ maxHops: 3 })))).toEqual(['A>B@1', 'B>C@2', 'C>D@3']);
    expect(path(await run(query({ maxHops: 1 })))).toEqual(['A>B@1']);
  });

  it('shows the edge into a stop address (labelled service) but never follows it', async () => {
    const run = await store().seed([
      transfer('A', 'S', day(1)),
      transfer('S', 'Z', day(2)),
      transfer('A', 'B', day(1)),
      transfer('B', 'C', day(2)),
    ]);
    expect(path(await run(query({ stopAt: ['S'] })))).toEqual(['A>S@1', 'A>B@1', 'B>C@2']);
  });

  it('follows funds upstream with negative hops and non-increasing time', async () => {
    const run = await store().seed([
      transfer('X', 'A', day(5)),
      transfer('W', 'X', day(3)),
      transfer('V', 'W', day(4)), // newer than W→X: not a source of those funds
      transfer('U', 'W', day(2)),
    ]);
    expect(path(await run(query({ direction: 'in' })))).toEqual(['X>A@-1', 'W>X@-2', 'U>W@-3']);
    expect(path(await run(query({ direction: 'in', maxHops: 2 })))).toEqual(['X>A@-1', 'W>X@-2']);
  });

  it('returns every transfer once, at its smallest hop, and keeps parallel transfers apart', async () => {
    const run = await store().seed([
      transfer('A', 'B', day(1), { tx: 'tx-1' }),
      transfer('A', 'C', day(1), { tx: 'tx-2' }),
      transfer('B', 'C', day(2), { tx: 'tx-3' }),
      transfer('C', 'D', day(3), { tx: 'tx-4' }), // reachable at hop 2 (A→C) and at hop 3 (A→B→C)
      transfer('A', 'B', day(1), { tx: 'tx-5', amount: '7' }), // a second transfer A→B
      transfer('A', 'B', day(1), { tx: 'tx-5', amount: '7', index: 1 }), // same tx, another log index
      transfer('A', 'B', day(1), { tx: 'tx-1' }), // exact repeat of tx-1: the same movement
    ]);
    const result = await run(query({}));
    expect(path(result)).toEqual(['A>B@1', 'A>C@1', 'A>B@1', 'A>B@1', 'B>C@2', 'C>D@2']);
    expect(result.rows.filter((r) => r.txHash === 'tx-5').map((r) => r.index)).toEqual([undefined, 1]);
  });

  it('uses the earliest arrival at an address and keeps the work linear for many parallel transfers', async () => {
    const early = await store().seed([
      transfer('A', 'B', day(3)),
      transfer('A', 'B', day(1)),
      transfer('B', 'C', day(2)), // after the earliest arrival at B (day 1)
    ]);
    expect(path(await early(query({})))).toEqual(['A>B@1', 'A>B@1', 'B>C@2']);
    // 400 parallel transfers per leg: a path-enumerating query would produce 400³ third-hop rows.
    const legs = (from: string, to: string, base: number) =>
      Array.from({ length: 400 }, (_, i) => transfer(from, to, day(base, i % 20)));
    const run = await store().seed([...legs('A', 'B', 1), ...legs('B', 'C', 2), ...legs('C', 'D', 3)]);
    const started = Date.now();
    const result = await run(query({ maxHops: 3, limit: 5000 }));
    expect(result.rows).toHaveLength(1200);
    expect([1, 2, 3].map((h) => result.rows.filter((r) => r.hop === h).length)).toEqual([400, 400, 400]);
    expect(result.truncated).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('cuts the result at the limit and says so', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => transfer('A', `N${i}`, day(1, i % 20)));
    const run = await store().seed(many);
    const cut = await run(query({ limit: 2000 }));
    expect(cut.rows).toHaveLength(2000);
    expect(cut.truncated).toBe(true);
    // The cut keeps the earliest edges in the documented order.
    expect(cut.rows[0]?.blockTime).toBe(day(1, 0));
    const whole = await run(query({ limit: 2500 }));
    expect(whole.rows).toHaveLength(2500);
    expect(whole.truncated).toBe(false);
  });

  it('compares EVM addresses case-insensitively and keeps chains apart', async () => {
    const lower = `0x${'ab'.repeat(20)}`;
    const mixed = `0x${'AB'.repeat(20)}`;
    const other = `0x${'cd'.repeat(20)}`;
    const run = await store().seed([
      transfer(mixed, other, day(1), { chain: ETH }),
      transfer('A', 'B', day(1)), // another chain
    ]);
    const found = await run(query({ chain: ETH, seeds: [lower] }));
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({ from: mixed, to: other, hop: 1, chain: ETH });
    expect((await run(query({ chain: ETH, seeds: ['A'] }))).rows).toEqual([]);
  });

  it('round-trips the transfer fields and orders by hop, time and transaction', async () => {
    const first = transfer('A', 'B', day(2), { tx: 'tx-b', index: 3 });
    const second = transfer('A', 'C', day(1), { tx: 'tx-c' });
    const run = await store().seed([first, second, transfer('C', 'D', day(3), { tx: 'tx-d' })]);
    const result = await run(query({}));
    expect(result.rows.map((r) => r.txHash)).toEqual(['tx-c', 'tx-b', 'tx-d']);
    expect(result.rows[1]).toMatchObject({ ...first, hop: 1, isCycle: false });
  });
}

describe('fund-flow queries (in-memory store)', () => {
  const memory: Store = {
    name: 'memory',
    async seed(transfers) {
      const repos = createMemoryRepositories();
      const runId = await prepareRun(repos);
      for (const t of transfers) {
        // oxlint-disable-next-line no-await-in-loop
        await repos.chain.addTransfers(runId, { chain: t.chain, address: t.from }, [t]);
      }
      return (q) => repos.chain.queryFlowEdges!(runId, q);
    },
  };
  scenarios(() => memory);
});

describe.skipIf(!enabled)('fund-flow queries (PostgreSQL recursive CTE: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;
  let repos: Repositories;
  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
    repos = createSqlRepositories(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  const sqlStore: Store = {
    name: 'sql',
    async seed(transfers) {
      const runId = await prepareRun(repos);
      for (let i = 0; i < transfers.length; i += 500) {
        const chunk = transfers.slice(i, i + 500);
        // Stored under their sender, one call per sender and chain.
        const groups = Map.groupBy(chunk, (t) => `${t.chain}|${t.from}`);
        for (const group of groups.values()) {
          const first = group[0]!;
          // oxlint-disable-next-line no-await-in-loop
          await repos.chain.addTransfers(runId, { chain: first.chain, address: first.from }, group);
        }
      }
      return (q) => repos.chain.queryFlowEdges!(runId, q);
    },
  };
  scenarios(() => sqlStore);

  it('lists only the analysed history; expansion transfers serve flow queries only', async () => {
    const runId = await prepareRun(repos);
    const own = transfer('A', 'B', day(1));
    const expansion = transfer('B', 'C', day(2));
    await repos.chain.addTransfers(runId, { chain: CHAIN, address: 'A' }, [own]);
    await repos.chain.addTransfers(runId, { chain: CHAIN, address: 'B' }, [expansion], { expansionHop: 1 });
    expect((await repos.chain.listTransfers(runId)).map((t) => t.txHash)).toEqual([own.txHash]);
    expect(path(await repos.chain.queryFlowEdges!(runId, query({})))).toEqual(['A>B@1', 'B>C@2']);
  });

  it('keeps flow edges and views append-only, once per run', async () => {
    const runId = await prepareRun(repos);
    const edge: FlowEdge = {
      from: { chain: CHAIN, address: 'A' },
      to: { chain: CHAIN, address: 'B' },
      asset: 'USDT',
      amount: '10.50',
      txHash: 'tx-flow',
      index: 2,
      at: day(1),
      hop: 1,
    };
    const priced: FlowEdge = { ...edge, hop: 2, isCycle: true };
    await repos.analysis.addFlows!(runId, [edge, priced]);
    await repos.analysis.addFlows!(runId, [edge]); // re-computation inserts nothing new
    expect(await repos.analysis.listFlows!(runId)).toEqual([edge, priced]);
    const view: FundFlowView = {
      runId,
      address: edge.from,
      timeline: [{ at: day(1), kind: 'transfer', txHashes: ['tx-flow'], hop: 1 }],
      sankey: { nodes: [], links: [] },
      truncated: true,
      computedAt: day(2),
    };
    await repos.analysis.addFlowViews!([view]);
    await repos.analysis.addFlowViews!([{ ...view, truncated: false }]); // already stored: kept
    expect(await repos.analysis.listFlowViews!(runId)).toEqual([view]);
    // The application role cannot change or remove computed results.
    const denied = /permission denied/;
    await expect(db.updateTable('flow_edge').set({ hop: 9 }).where('run_id', '=', runId).execute()).rejects.toThrow(
      denied,
    );
    await expect(db.deleteFrom('flow_edge').where('run_id', '=', runId).execute()).rejects.toThrow(denied);
    await expect(
      db.updateTable('fund_flow_view').set({ truncated: false }).where('run_id', '=', runId).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('fund_flow_view').where('run_id', '=', runId).execute()).rejects.toThrow(denied);
  });
});

describe('fund-flow edges and views (in-memory store)', () => {
  it('keeps an edge once per run and hop, like the SQL primary key', async () => {
    const repos = createMemoryRepositories();
    const runId = await prepareRun(repos);
    const edge: FlowEdge = {
      from: { chain: CHAIN, address: 'A' },
      to: { chain: CHAIN, address: 'B' },
      asset: 'USDT',
      amount: '10.50',
      txHash: 'tx-flow',
      at: day(1),
      hop: 1,
    };
    await repos.analysis.addFlows!(runId, [edge, { ...edge, hop: 2 }]);
    await repos.analysis.addFlows!(runId, [edge]);
    expect(await repos.analysis.listFlows!(runId)).toEqual([edge, { ...edge, hop: 2 }]);
  });
});

async function prepareRun(repos: Repositories): Promise<string> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test przepływów)',
      purpose: 'Test przepływów środków na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
    },
    'test',
  );
  const run: AnalysisRun = {
    id: newId(),
    caseId: kase.id,
    trigger: 'manual',
    mode: 'offline',
    status: 'running',
    config: {
      toolVersion: '0.0.0',
      sourcesConfigSha256: 'a',
      weightsVersion: 'w',
      weightsSha256: 'b',
      rulesVersions: {},
    },
    queuedAt: new Date().toISOString(),
  };
  await repos.runs.create(run);
  return run.id;
}
