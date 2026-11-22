/**
 * Co-spend clusters in both stores: the same contract (every field round-trips, one cluster id per run, the run must
 * exist, listed by id, previous sizes from the newest earlier run of the case) and append-only privileges of the
 * application role in PostgreSQL. Synthetic addresses.
 */
import type { AddressCluster, AnalysisRun, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

async function seedCase(repos: Repositories) {
  return repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test klastrów)',
      purpose: 'Test klastrów adresów na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
    },
    'test',
  );
}

let clock = Date.parse('2026-11-21T10:00:00.000Z');
async function seedRun(repos: Repositories, caseId: string): Promise<AnalysisRun> {
  clock += 60_000;
  const run: AnalysisRun = {
    id: newId(),
    caseId,
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
    queuedAt: new Date(clock).toISOString(),
  };
  await repos.runs.create(run);
  return run;
}

/** Every field once. */
function clusters(runId: string): AddressCluster[] {
  return [
    {
      id: 'c_bbbbbbbbbbbbbbbb',
      runId,
      chain: 'bitcoin',
      heuristic: 'co_spend',
      algorithmVersion: 'cospend.v1',
      seeds: ['bc1q-seed'],
      members: ['bc1q-partner', 'bc1q-seed'],
      size: 2,
      previousSize: 1,
      mergeEvidence: [{ address: 'bc1q-partner', txid: 'tx-1' }],
      skipped: [{ txid: 'tx-2', reason: 'coinjoin_wasabi' }],
      serviceMembers: [{ address: 'bc1q-hot', labelId: newId() }],
      flags: { serviceMerge: true, capped: false, growthFactor: 2 },
    },
    {
      id: 'c_aaaaaaaaaaaaaaaa',
      runId,
      chain: 'bitcoin',
      heuristic: 'co_spend',
      algorithmVersion: 'cospend.v1',
      seeds: ['bc1q-other'],
      members: ['bc1q-other'],
      size: 1,
      mergeEvidence: [],
      skipped: [],
      serviceMembers: [],
      flags: { serviceMerge: false, capped: false },
    },
  ];
}

async function contract(repos: Repositories): Promise<void> {
  const repo = repos.clusters!;
  const kase = await seedCase(repos);
  const first = await seedRun(repos, kase.id);
  const items = clusters(first.id);
  await repo.add(first.id, items);
  // Ordered by id; every field round-trips, absent optional fields stay absent.
  expect(await repo.list(first.id)).toEqual(items.toSorted((a, b) => (a.id < b.id ? -1 : 1)));
  expect(await repo.list(newId())).toEqual([]);
  await expect(repo.add(first.id, [items[0]!])).rejects.toThrow(/already stored|duplicate key/);
  await expect(repo.add(newId(), [items[0]!])).rejects.toThrow(/not found|foreign key/);
  await repo.add(first.id, []);

  // Previous sizes: the newest earlier run of the same case with a cluster of the seed wins.
  const second = await seedRun(repos, kase.id);
  await repo.add(second.id, [{ ...items[0]!, runId: second.id, size: 7 }]);
  const third = await seedRun(repos, kase.id);
  expect([...(await repo.previousSizes(kase.id, ['bc1q-seed', 'bc1q-other', 'bc1q-none'], third.id))]).toEqual(
    expect.arrayContaining([
      ['bc1q-seed', 7],
      ['bc1q-other', 1],
    ]),
  );
  expect((await repo.previousSizes(kase.id, ['bc1q-seed'], second.id)).get('bc1q-seed')).toBe(2);
  expect((await repo.previousSizes(kase.id, ['bc1q-seed'], first.id)).size).toBe(0);
  expect((await repo.previousSizes(kase.id, [], third.id)).size).toBe(0);
  // Other cases' runs never count.
  const otherCase = await seedCase(repos);
  const foreign = await seedRun(repos, otherCase.id);
  expect((await repo.previousSizes(otherCase.id, ['bc1q-seed'], foreign.id)).size).toBe(0);
}

describe('address clusters (memory)', () => {
  it('round-trip every field, refuse repeats and report previous sizes', async () => {
    await expect(contract(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)('address clusters (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('round-trip every field, refuse repeats and report previous sizes', async () => {
    await expect(contract(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated or deleted by the application role', async () => {
    const repos = createSqlRepositories(db);
    const kase = await seedCase(repos);
    const run = await seedRun(repos, kase.id);
    await repos.clusters!.add(run.id, clusters(run.id));
    const denied = /permission denied/;
    await expect(
      db.updateTable('address_cluster').set({ size: 9 }).where('run_id', '=', run.id).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('address_cluster').where('run_id', '=', run.id).execute()).rejects.toThrow(denied);
    expect((await repos.clusters!.list(run.id)).map((c) => c.size)).toEqual([1, 2]);
  });

  it('refuses a malformed cluster id', async () => {
    const repos = createSqlRepositories(db);
    const run = await seedRun(repos, (await seedCase(repos)).id);
    await expect(repos.clusters!.add(run.id, [{ ...clusters(run.id)[0]!, id: 'cluster-1' }])).rejects.toThrow(
      /check constraint/,
    );
  });
});
