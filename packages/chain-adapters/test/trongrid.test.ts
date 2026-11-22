import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import { createTronGridProvider, mapTrc20Items, USDT_TRC20, type ChainProviderConfig } from '../src/index.ts';
import { FakeEgressClient, fixtureEgress, REPO_ROOT, startFixtureSite, testContext } from './helpers/fake-egress.ts';

const config: ChainProviderConfig = {
  id: 'trongrid-test',
  kind: 'trongrid',
  sourceId: 'trongrid',
  baseUrl: 'https://trongrid.example.test',
  chains: ['tron'],
  priority: 1,
  apiKeyEnv: 'TEST_TRON_KEY',
};
// Synthetic placeholders: the adapter treats base58 addresses as opaque strings.
const ME = 'TSyntheticAddressMe000000000000000';
const OTHER = 'TSyntheticAddressOther00000000000';
const item = (over: Record<string, unknown> = {}) => ({
  transaction_id: 'a'.repeat(64),
  token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6, name: 'Tether USD' },
  block_timestamp: Date.parse('2026-11-12T08:45:00Z'),
  from: ME,
  to: OTHER,
  type: 'Transfer',
  value: '1500000000',
  ...over,
});

describe('TronGrid mapping', () => {
  it('maps TRC-20 transfers by contract and skips approvals', () => {
    const items = mapTrc20Items([item(), item({ type: 'Approval' }), item({ value: '2500000' })], 'f');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      chain: 'tron',
      kind: 'token',
      amount: '1500',
      blockHeight: 0,
      blockTime: '2026-11-12T08:45:00.000Z',
      asset: { symbol: 'USDT', decimals: 6, contract: USDT_TRC20 },
    });
    expect(items[1]).toMatchObject({ amount: '2.5' });
    // no log index on TRC-20 items: a content-based index, distinct within the transaction and stable across pages
    expect(items[0]?.index).not.toBe(items[1]?.index);
    expect(mapTrc20Items([item({ value: '2500000' })], 'other-page')[0]?.index).toBe(items[1]?.index);
  });
});

describe('TronGrid provider', () => {
  it('pages by fingerprint with otherwise identical parameters and sends the key as a secret header', async () => {
    const http = new FakeEgressClient((r) =>
      new URL(r.url).searchParams.has('fingerprint')
        ? { body: { data: [item({ transaction_id: 'b'.repeat(64) })], success: true, meta: { page_size: 1 } } }
        : { body: { data: [item()], success: true, meta: { page_size: 1, fingerprint: 'fp1' } } },
    );
    const provider = createTronGridProvider(
      { ...config, options: { usdtOnly: true } },
      { env: { TEST_TRON_KEY: 'k' } },
    );
    const ctx = testContext(http);
    const first = await provider.listTransfers({ chain: 'tron', address: ME }, {}, ctx);
    expect(first.nextCursor).toBeDefined();
    const second = await provider.listTransfers(
      { chain: 'tron', address: ME },
      { cursor: first.nextCursor ?? '' },
      ctx,
    );
    expect(second.nextCursor).toBeUndefined();
    const [a, b] = http.requests.map((r) => new URL(r.url).searchParams);
    expect(b?.get('fingerprint')).toBe('fp1');
    b?.delete('fingerprint');
    expect(b?.toString()).toBe(a?.toString());
    expect(a?.get('contract_address')).toBe(USDT_TRC20);
    expect(a?.get('only_confirmed')).toBe('true');
    expect(http.requests.every((r) => r.headers?.['TRON-PRO-API-KEY'] === 'k')).toBe(true);
    expect(http.requests.every((r) => r.secretParams?.includes('TRON-PRO-API-KEY'))).toBe(true);
  });

  it('reads contract code from wallet/getcontract: bytecode, none, or a node error', async () => {
    const bytecode = `6080604052${'ab'.repeat(8)}`;
    const http = new FakeEgressClient((r) => {
      const value = new URL(r.url).searchParams.get('value');
      if (value === ME) return { body: { bytecode: bytecode.toUpperCase(), name: 'Synthetic', contract_address: ME } };
      if (value === OTHER) return { body: {} };
      return { body: { Error: 'class java.lang.IllegalArgumentException : invalid address' } };
    });
    const provider = createTronGridProvider(config, { env: {} });
    const ctx = testContext(http);
    expect((await provider.getCode!({ chain: 'tron', address: ME }, ctx)).code).toBe(`0x${bytecode}`);
    expect((await provider.getCode!({ chain: 'tron', address: OTHER }, ctx)).code).toBe('0x');
    await expect(provider.getCode!({ chain: 'tron', address: 'Tbroken' }, ctx)).rejects.toMatchObject({
      kind: 'upstream_error',
    });
    expect(new URL(http.requests[0]!.url).pathname).toBe('/wallet/getcontract');
    expect(new URL(http.requests[0]!.url).searchParams.get('visible')).toBe('true');
    expect(http.requests.every((r) => r.containsIdentifier)).toBe(true);
  });

  it('reads the solidified tip and treats success:false as an upstream error', async () => {
    const http = new FakeEgressClient((r) =>
      r.url.endsWith('/walletsolidity/getnowblock')
        ? { body: { blockID: 'ab'.repeat(32), block_header: { raw_data: { number: 76_543_210, timestamp: 1 } } } }
        : { body: { success: false, error: 'boom' } },
    );
    const provider = createTronGridProvider(config, { env: {} });
    const ctx = testContext(http);
    expect(await provider.getTip('tron', ctx)).toMatchObject({ height: 76_543_210, hash: 'ab'.repeat(32) });
    await expect(provider.getAddressSummary({ chain: 'tron', address: ME }, ctx)).rejects.toMatchObject({
      kind: 'upstream_error',
    });
  });
});

describe('TronGrid provider against the synthetic fixture site', () => {
  let site: FixtureServer;
  let tron1 = '';
  beforeAll(async () => {
    site = await startFixtureSite();
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'fixtures', 'persona', 'manifest.json'), 'utf8')) as {
      addresses: Record<string, { address: string }>;
    };
    tron1 = manifest.addresses['TRON-1']?.address ?? '';
  });
  afterAll(() => site.close());

  it('lists the USDT history of TRON-1', async () => {
    const provider = createTronGridProvider({ ...config, baseUrl: `${site.url}/chain/trongrid` }, { env: {} });
    const ctx = testContext(fixtureEgress());
    const page = await provider.listTransfers({ chain: 'tron', address: tron1 }, {}, ctx);
    expect(page.items).toHaveLength(9);
    expect(page.items.every((t) => t.asset.contract === USDT_TRC20)).toBe(true);
    expect((await provider.getAddressSummary({ chain: 'tron', address: tron1 }, ctx)).balance).toBe('35');
    // TRON-1 is an account, not a smart contract
    expect((await provider.getCode!({ chain: 'tron', address: tron1 }, ctx)).code).toBe('0x');
  });
});
