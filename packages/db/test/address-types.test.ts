/**
 * Address-type classifications in both stores: the same contract (fetch ids round-trip in call order, one
 * classification per run and address, the run must exist, listed by chain then address) and append-only privileges
 * of the application role in PostgreSQL. Synthetic addresses.
 */
import type { AddressTypeClassification, AnalysisRun, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

async function seedRun(repos: Repositories): Promise<AnalysisRun> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test typów adresów)',
      purpose: 'Test typów adresów na danych syntetycznych',
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
    queuedAt: '2026-11-21T10:00:00.000Z',
  };
  await repos.runs.create(run);
  return run;
}

/** Every optional field once, fetch ids deliberately not in sorted order. */
function classifications(): AddressTypeClassification[] {
  const [f1, f2, f3, f4, f5] = [newId(), newId(), newId(), newId(), newId()];
  return [
    {
      address: { chain: 'evm:1', address: `0x${'5a'.repeat(20)}` },
      type: 'safe',
      codePrefix: '0x60806040',
      codeSize: 171,
      safeMasterCopy: '0x41675c099f32341bf84bfc5382af534df5c7461a',
      fetchIds: [f3!, f1!],
    },
    {
      address: { chain: 'evm:1', address: `0x${'1a'.repeat(20)}` },
      type: 'delegated_eoa',
      codePrefix: '0xef0100',
      codeSize: 23,
      delegate: `0x${'ab'.repeat(20)}`,
      fetchIds: [f2!],
    },
    {
      address: { chain: 'evm:1', address: `0x${'4a'.repeat(20)}` },
      type: 'erc4337_account',
      codePrefix: '0x60806040',
      codeSize: 90,
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      implementation: `0x${'1e'.repeat(20)}`,
      fetchIds: [f5!, f4!, f2!],
    },
    {
      address: { chain: 'bitcoin', address: 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2' },
      type: 'utxo_script',
      scriptType: 'p2wpkh',
      fetchIds: [],
    },
    {
      address: { chain: 'tron', address: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu' },
      type: 'unknown',
      failedProbe: { probe: 'code', message: 'trongrid: rate_limited: HTTP 429' },
      fetchIds: [f4!],
    },
  ];
}

const byKey = (items: readonly AddressTypeClassification[]) =>
  items.toSorted((a, b) =>
    a.address.chain === b.address.chain
      ? a.address.address < b.address.address
        ? -1
        : 1
      : a.address.chain < b.address.chain
        ? -1
        : 1,
  );

async function roundTrip(repos: Repositories): Promise<void> {
  const run = await seedRun(repos);
  const items = classifications();
  await repos.addressTypes!.add(run.id, items);
  expect(await repos.addressTypes!.list(run.id)).toEqual(byKey(items));
  expect(await repos.addressTypes!.list(newId())).toEqual([]);
  // One classification per run and address; another run may classify it again ("as of its chain tip").
  await expect(repos.addressTypes!.add(run.id, [items[0]!])).rejects.toThrow(/already stored|duplicate key/);
  const later = await seedRun(repos);
  await repos.addressTypes!.add(later.id, [{ ...items[0]!, type: 'contract', fetchIds: [newId()] }]);
  expect((await repos.addressTypes!.list(later.id)).map((c) => c.type)).toEqual(['contract']);
  expect(await repos.addressTypes!.list(run.id)).toHaveLength(items.length);
  await expect(repos.addressTypes!.add(newId(), [items[0]!])).rejects.toThrow(/not found|foreign key/);
  await repos.addressTypes!.add(run.id, []);
}

describe('address types (memory)', () => {
  it('round-trip every field and keep one classification per run and address', async () => {
    await expect(roundTrip(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)('address types (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('round-trip every field and keep one classification per run and address', async () => {
    await expect(roundTrip(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated or deleted by the application role', async () => {
    const repos = createSqlRepositories(db);
    const run = await seedRun(repos);
    await repos.addressTypes!.add(run.id, classifications().slice(0, 1));
    const denied = /permission denied/;
    await expect(
      db.updateTable('address_type_classification').set({ type: 'eoa' }).where('run_id', '=', run.id).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('address_type_classification').where('run_id', '=', run.id).execute()).rejects.toThrow(
      denied,
    );
    expect((await repos.addressTypes!.list(run.id)).map((c) => c.type)).toEqual(['safe']);
  });

  it('refuses types outside the vocabulary', async () => {
    const run = await seedRun(createSqlRepositories(db));
    await expect(
      db
        .insertInto('address_type_classification')
        .values({ run_id: run.id, chain: 'evm:1', address: '0x00', type: 'wallet' as never, fetch_ids: [] })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });
});
