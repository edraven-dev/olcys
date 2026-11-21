import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  createEsploraProvider,
  deriveTransfers,
  mapEsploraTx,
  type ChainProviderConfig,
  type EsploraTx,
} from '../src/index.ts';
import {
  FakeEgressClient,
  fixtureEgress,
  REPO_ROOT,
  routes,
  startFixtureSite,
  testContext,
} from './helpers/fake-egress.ts';

// Synthetic placeholders (not real addresses): the mapping code treats addresses as opaque strings.
const A = 'bc1qsyntheticaddressa';
const H = 'bc1qsyntheticaddressh';
const X = 'bc1qsyntheticaddressx';
const Y = 'bc1qsyntheticaddressy';

const config: ChainProviderConfig = {
  id: 'esplora-test',
  kind: 'esplora',
  sourceId: 'mempool_space',
  baseUrl: 'https://esplora.example.test/api',
  chains: ['bitcoin'],
  priority: 1,
};

const out = (address: string | undefined, value: number, type = 'v0_p2wpkh') => ({
  ...(address ? { scriptpubkey_address: address } : {}),
  scriptpubkey_type: type,
  value,
});
const confirmed = { confirmed: true, block_height: 925_000, block_hash: 'b'.repeat(64), block_time: 1_793_628_000 };

const spend: EsploraTx = {
  txid: 'a'.repeat(64),
  vin: [{ txid: 'f'.repeat(64), vout: 0, prevout: out(A, 10_000_000) }],
  vout: [out(H, 5_000_000), out(A, 4_980_000), out(undefined, 0, 'op_return')],
  fee: 20_000,
  status: confirmed,
};
const receipt: EsploraTx = {
  txid: 'c'.repeat(64),
  vin: [
    { txid: 'd'.repeat(64), vout: 1, prevout: out(X, 7_000_000) },
    { txid: 'e'.repeat(64), vout: 0, prevout: out(Y, 4_000_000) },
  ],
  vout: [out(A, 10_000_000), out(Y, 990_000)],
  fee: 10_000,
  status: confirmed,
};

describe('Esplora mapping', () => {
  it('maps inputs, outputs, OP_RETURN, coinbase and fee', () => {
    const mapped = mapEsploraTx(spend, 'bitcoin', 'f1');
    expect(mapped.fee).toBe('0.0002');
    expect(mapped.blockTime).toBe('2026-11-02T14:00:00.000Z');
    expect(mapped.outputs[2]).toEqual({ value: '0', n: 2, scriptType: 'op_return' });
    const coinbase = mapEsploraTx(
      { ...spend, vin: [{ is_coinbase: true, txid: '0'.repeat(64), vout: 4294967295, prevout: null }] },
      'bitcoin',
      'f1',
    );
    expect(coinbase.inputs[0]).toEqual({ value: '0', prevTxid: '0'.repeat(64), vout: 4294967295 });
  });

  it('derives one transfer per payment and ignores change', () => {
    const spent = deriveTransfers(mapEsploraTx(spend, 'bitcoin', 'f1'), A, 'bh');
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ from: A, to: H, amount: '0.05', index: 0, kind: 'native', blockHash: 'bh' });
    const received = deriveTransfers(mapEsploraTx(receipt, 'bitcoin', 'f2'), A);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: X, to: A, amount: '0.1', asset: { symbol: 'BTC', decimals: 8 } });
  });
});

describe('Esplora provider', () => {
  it('pages newest-first by last seen txid and shares pages between listings', async () => {
    const page = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ ...spend, txid: `${prefix}${String(i).padStart(63, '0')}` }));
    const p1 = page(25, '1');
    const p2 = page(25, '2');
    const p3 = page(7, '3');
    const unconfirmed = { ...spend, txid: 'u'.repeat(64), status: { confirmed: false } };
    const http = new FakeEgressClient(
      routes({
        [`/address/${A}/txs`]: { body: [unconfirmed, ...p1] },
        [`/txs/chain/${p1[24]?.txid}`]: { body: p2 },
        [`/txs/chain/${p2[24]?.txid}`]: { body: p3 },
      }),
    );
    const provider = createEsploraProvider(config);
    const ctx = testContext(http);
    const address = { chain: 'bitcoin' as const, address: A };
    const all = [];
    let cursor: string | undefined;
    do {
      // Pages depend on the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      const result = await provider.listUtxoTransactions!(address, cursor ? { cursor } : {}, ctx);
      all.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(57);
    expect(all.some((tx) => tx.txid === unconfirmed.txid)).toBe(false);
    expect(http.requests.map((r) => r.url.replace(config.baseUrl, ''))).toEqual([
      `/address/${A}/txs`,
      `/address/${A}/txs/chain/${p1[24]?.txid}`,
      `/address/${A}/txs/chain/${p2[24]?.txid}`,
    ]);
    expect(http.requests.every((r) => r.containsIdentifier)).toBe(true);
    // the same first page for listTransfers costs no extra request
    await provider.listTransfers(address, {}, ctx);
    expect(http.requests).toHaveLength(3);
  });

  it('maps the address summary and the tip height', async () => {
    const http = new FakeEgressClient(
      routes({
        [`/address/${A}`]: {
          body: {
            chain_stats: {
              funded_txo_count: 2,
              funded_txo_sum: 14_980_000,
              spent_txo_count: 1,
              spent_txo_sum: 10_000_000,
              tx_count: 2,
            },
          },
        },
        '/blocks/tip/height': { body: '925000' },
      }),
    );
    const provider = createEsploraProvider(config);
    const summary = await provider.getAddressSummary({ chain: 'bitcoin', address: A }, testContext(http));
    expect(summary).toMatchObject({ txCount: 2, totalReceived: '0.1498', totalSent: '0.1', balance: '0.0498' });
    const tip = await provider.getTip('bitcoin', testContext(http));
    expect(tip.height).toBe(925_000);
    expect(http.requests.at(-1)?.containsIdentifier).toBe(false);
  });
});

describe('Esplora provider against the synthetic fixture site', () => {
  let site: FixtureServer;
  let btc1 = '';
  beforeAll(async () => {
    site = await startFixtureSite();
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'fixtures', 'persona', 'manifest.json'), 'utf8')) as {
      addresses: Record<string, { address: string }>;
    };
    btc1 = manifest.addresses['BTC-1']?.address ?? '';
  });
  afterAll(() => site.close());

  it('reads BTC-1 from the fixture paths of the real API', async () => {
    const provider = createEsploraProvider({ ...config, baseUrl: `${site.url}/chain/esplora/api` });
    const ctx = testContext(fixtureEgress());
    const address = { chain: 'bitcoin' as const, address: btc1 };
    const summary = await provider.getAddressSummary(address, ctx);
    expect(summary.balance).toBe('0.04');
    const txs = await provider.listUtxoTransactions!(address, {}, ctx);
    expect(txs.items).toHaveLength(5);
    expect(txs.nextCursor).toBeUndefined();
    const transfers = await provider.listTransfers(address, {}, ctx);
    const incoming = transfers.items.filter((t) => t.to === btc1);
    expect(incoming.map((t) => t.amount).toSorted()).toEqual(['0.04', '0.1', '0.25']);
    expect((await provider.getTip('bitcoin', ctx)).height).toBeGreaterThan(977_000);
  });
});
