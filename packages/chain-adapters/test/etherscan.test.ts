import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressRequest } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  ChainProviderError,
  classifyEthCall,
  classifyEtherscan,
  createEtherscanProvider,
  decodeCursor,
  mapEtherscanRows,
  type ChainProviderConfig,
  type EtherscanCursor,
} from '../src/index.ts';
import { FakeEgressClient, fixtureEgress, REPO_ROOT, startFixtureSite, testContext } from './helpers/fake-egress.ts';

const config: ChainProviderConfig = {
  id: 'etherscan-test',
  kind: 'etherscan',
  sourceId: 'etherscan_v2',
  baseUrl: 'https://etherscan.example.test/v2/api',
  chains: ['evm:1'],
  priority: 1,
  apiKeyEnv: 'TEST_ETHERSCAN_KEY',
};
// Synthetic 20-byte placeholders.
const ME = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const TOKEN = '0x00000000000000000000000000000000000000c3';

const row = (over: Record<string, string>) => ({
  blockNumber: '26150100',
  timeStamp: '1791969120',
  hash: '0x' + '1'.repeat(64),
  blockHash: '0x' + '2'.repeat(64),
  from: OTHER,
  to: ME,
  value: '500000000000000000',
  isError: '0',
  txreceipt_status: '1',
  contractAddress: '',
  methodId: '0x',
  functionName: '',
  ...over,
});

const params = (r: EgressRequest) => new URL(r.url).searchParams;

describe('Etherscan mapping', () => {
  it('maps native rows: value, failed rows, contract creation and method names', () => {
    const items = mapEtherscanRows(
      'normal',
      [
        row({}),
        row({ hash: '0x' + '3'.repeat(64), isError: '1' }),
        row({ hash: '0x' + '4'.repeat(64), to: '', contractAddress: TOKEN, from: ME }),
        row({ hash: '0x' + '5'.repeat(64), functionName: 'transfer(address _to, uint256 _value)', value: '0' }),
      ],
      'evm:1',
      'f',
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ amount: '0.5', kind: 'native', asset: { symbol: 'ETH', decimals: 18 } });
    expect(items[0]?.blockTime).toBe('2026-10-14T09:12:00.000Z');
    expect(items[1]?.to).toBe(TOKEN);
    expect(items[2]).toMatchObject({ method: 'transfer', amount: '0' });
  });

  it('identifies tokens by contract and drops zero-value spam', () => {
    const items = mapEtherscanRows(
      'token',
      [
        row({
          value: '3000000000',
          tokenSymbol: 'USDT',
          tokenDecimal: '6',
          contractAddress: TOKEN.toUpperCase().replace('0X', '0x'),
          logIndex: '7',
        }),
        row({ value: '0', tokenSymbol: 'USDT', tokenDecimal: '6', contractAddress: TOKEN }),
      ],
      'evm:1',
      'f',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      amount: '3000',
      index: 7,
      kind: 'token',
      asset: { symbol: 'USDT', contract: TOKEN },
    });
  });

  it('classifies error bodies', () => {
    expect(classifyEtherscan({ status: '0', message: 'No transactions found', result: [] })).toBe('ok');
    expect(classifyEtherscan({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' })).toBe('rate_limited');
    expect(classifyEtherscan({ status: '0', message: 'NOTOK', result: 'Invalid API Key' })).toBe('auth_error');
    expect(
      classifyEtherscan({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }),
    ).toBe('plan_restricted');
    expect(classifyEtherscan({ jsonrpc: '2.0', id: 1, error: { code: -32000 } })).toBe('upstream_error');
    expect(classifyEtherscan({ jsonrpc: '2.0', id: 1, result: '0x' })).toBe('ok');
  });
});

describe('Etherscan provider', () => {
  it('walks txlist → txlistinternal → tokentx and pins the end block', async () => {
    const http = new FakeEgressClient((r) => {
      const action = params(r).get('action');
      if (action === 'txlist') return { body: { status: '1', message: 'OK', result: [row({})] } };
      return { body: { status: '0', message: 'No transactions found', result: [] } };
    });
    const provider = createEtherscanProvider(config, { env: {} });
    const ctx = testContext(http);
    const address = { chain: 'evm:1' as const, address: ME };
    const items = [];
    let cursor: string | undefined;
    do {
      // Pages depend on the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page = await provider.listTransfers(address, { ...(cursor ? { cursor } : {}), toBlock: 26_160_000 }, ctx);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(items).toHaveLength(1);
    expect(http.requests.map((r) => params(r).get('action'))).toEqual(['txlist', 'txlistinternal', 'tokentx']);
    expect(
      http.requests.every((r) => params(r).get('endblock') === '26160000' && params(r).get('chainid') === '1'),
    ).toBe(true);
    // no key configured → no apikey parameter at all
    expect(http.requests.some((r) => params(r).has('apikey'))).toBe(false);
  });

  it('opens a new window at the last block when ten pages are full', async () => {
    const pageSize = 2;
    const http = new FakeEgressClient((r) => {
      const p = params(r);
      if (p.get('action') !== 'txlist') return { body: { status: '0', message: 'No transactions found', result: [] } };
      const page = Number(p.get('page'));
      const start = Number(p.get('startblock'));
      if (start === 0) {
        const base = (page - 1) * 2;
        return {
          body: {
            status: '1',
            message: 'OK',
            result: [
              row({ blockNumber: String(base + 1), hash: `0xa${base}` }),
              row({ blockNumber: String(base + 2), hash: `0xb${base}` }),
            ],
          },
        };
      }
      return { body: { status: '1', message: 'OK', result: [row({ blockNumber: String(start), hash: '0xb18' })] } };
    });
    const provider = createEtherscanProvider({ ...config, options: { pageSize, windowRows: 20 } }, { env: {} });
    const ctx = testContext(http);
    let cursor: string | undefined;
    const hashes: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      // Pages depend on the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page = await provider.listTransfers({ chain: 'evm:1', address: ME }, cursor ? { cursor } : {}, ctx);
      hashes.push(...page.items.map((t) => t.txHash));
      cursor = page.nextCursor;
      if (cursor && decodeCursor<EtherscanCursor>('etherscan-test', cursor).stream !== 'normal') break;
    }
    const eleventh = http.requests[10];
    expect(eleventh && params(eleventh).get('page')).toBe('1');
    expect(eleventh && params(eleventh).get('startblock')).toBe('20');
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes).toHaveLength(20);
  });

  it('reads code, balance and the tip; the API key is sent but marked secret', async () => {
    const http = new FakeEgressClient((r) => {
      const action = params(r).get('action');
      if (action === 'eth_getCode') return { body: { jsonrpc: '2.0', id: 1, result: '0xEF0100' + 'ab'.repeat(20) } };
      if (action === 'eth_blockNumber') return { body: { jsonrpc: '2.0', id: 83, result: '0x18f2b80' } };
      return { body: { status: '1', message: 'OK', result: '1500000000000000000' } };
    });
    const provider = createEtherscanProvider(config, { env: { TEST_ETHERSCAN_KEY: 'k-123' } });
    const ctx = testContext(http);
    expect((await provider.getCode!({ chain: 'evm:1', address: ME }, ctx)).code).toBe('0xef0100' + 'ab'.repeat(20));
    expect((await provider.getAddressSummary({ chain: 'evm:1', address: ME }, ctx)).balance).toBe('1.5');
    expect((await provider.getTip('evm:1', ctx)).height).toBe(26_160_000);
    expect(http.requests.every((r) => params(r).get('apikey') === 'k-123' && r.secretParams?.includes('apikey'))).toBe(
      true,
    );
    expect(http.requests.at(-1)?.containsIdentifier).toBe(false);
  });

  it('probes storage and calls at latest: a revert is an answer, other JSON-RPC errors fail', async () => {
    const word = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`;
    const http = new FakeEgressClient((r) => {
      const p = params(r);
      if (p.get('action') === 'eth_getStorageAt')
        return { body: { jsonrpc: '2.0', id: 1, result: word.toUpperCase().replace('0X', '0x') } };
      if (p.get('data') === '0xb0d691fe') return { body: { jsonrpc: '2.0', id: 1, result: word } };
      if (p.get('data') === '0x18160ddd') {
        return { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } } };
      }
      if (p.get('data') === '0x313ce567')
        return { body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'x', data: '0x' } } };
      return { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid argument 0' } } };
    });
    const provider = createEtherscanProvider(config, { env: {} });
    const ctx = testContext(http);
    const me = { chain: 'evm:1' as const, address: ME };
    expect(await provider.getStorageAt!(me, '0x0', ctx)).toEqual({ value: word, fetchId: expect.any(String) });
    expect(await provider.call!(me, '0xb0d691fe', ctx)).toMatchObject({ status: 'ok', data: word });
    expect(await provider.call!(me, '0x18160ddd', ctx)).toEqual({ status: 'reverted', fetchId: expect.any(String) });
    expect((await provider.call!(me, '0x313ce567', ctx)).status).toBe('reverted');
    await expect(provider.call!(me, '0x12345678', ctx)).rejects.toMatchObject({ kind: 'upstream_error' });
    expect(params(http.requests[0]!).toString()).toBe(
      `chainid=1&module=proxy&action=eth_getStorageAt&address=${ME}&position=0x0&tag=latest`,
    );
    expect(params(http.requests[1]!).toString()).toBe(
      `chainid=1&module=proxy&action=eth_call&to=${ME}&data=0xb0d691fe&tag=latest`,
    );
    expect(http.requests.every((r) => r.containsIdentifier && r.purpose.includes('address type probe'))).toBe(true);
  });

  it('classifies eth_call bodies: reverts are results, throttling stays throttling', () => {
    expect(classifyEthCall({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })).toBe(
      'ok',
    );
    expect(classifyEthCall({ jsonrpc: '2.0', id: 1, result: '0x' })).toBe('ok');
    expect(classifyEthCall({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } })).toBe(
      'upstream_error',
    );
    expect(classifyEthCall({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' })).toBe('rate_limited');
  });

  it('refuses chains it is not configured for, without a request', async () => {
    const http = new FakeEgressClient(() => ({ body: {} }));
    const provider = createEtherscanProvider(config, { env: {} });
    await expect(provider.getCode!({ chain: 'evm:8453', address: ME }, testContext(http))).rejects.toBeInstanceOf(
      ChainProviderError,
    );
    expect(http.requests).toHaveLength(0);
  });
});

describe('Etherscan provider against the synthetic fixture site', () => {
  let site: FixtureServer;
  let slots: Record<string, { address: string }> = {};
  beforeAll(async () => {
    site = await startFixtureSite();
    slots = (
      JSON.parse(await readFile(join(REPO_ROOT, 'fixtures', 'persona', 'manifest.json'), 'utf8')) as {
        addresses: Record<string, { address: string }>;
      }
    ).addresses;
  });
  afterAll(() => site.close());

  it('lists ETH-1 deposit and sweep and tells the contract from an EOA', async () => {
    const provider = createEtherscanProvider({ ...config, baseUrl: `${site.url}/chain/etherscan/v2/api` }, { env: {} });
    const ctx = testContext(fixtureEgress());
    const eth1 = { chain: 'evm:1' as const, address: (slots['ETH-1']?.address ?? '').toLowerCase() };
    const items = [];
    let cursor: string | undefined;
    do {
      // Pages depend on the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page = await provider.listTransfers(eth1, cursor ? { cursor } : {}, ctx);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(items.map((t) => t.amount)).toEqual(['1.5', '1.499559']);
    expect(items[1]?.to).toBe(slots['HOT-1']?.address.toLowerCase());
    const contract = { chain: 'evm:1' as const, address: (slots['CONTRACT-1']?.address ?? '').toLowerCase() };
    expect((await provider.getCode!(contract, ctx)).code.startsWith('0x6080')).toBe(true);
    expect((await provider.getCode!(eth1, ctx)).code).toBe('0x');
    expect((await provider.getTip('evm:1', ctx)).height).toBeGreaterThan(26_400_000);
    // CONTRACT-1 is a plain contract: empty storage slots, every probed function reverts
    expect((await provider.getStorageAt!(contract, '0x0', ctx)).value).toBe(`0x${'0'.repeat(64)}`);
    expect((await provider.call!(contract, '0xb0d691fe', ctx)).status).toBe('reverted');
    expect(await provider.call!(eth1, '0xb0d691fe', ctx)).toMatchObject({ status: 'ok', data: '0x' });
  });
});
