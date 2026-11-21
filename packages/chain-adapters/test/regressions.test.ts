/**
 * Regression tests for review findings: transfers without a log index keep distinct, stable indexes across pages,
 * and a dense block never erases the history fetched before it. Synthetic placeholders only.
 */
import type { EgressRequest } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { createChainProviderRegistry, runChainFetch, type ChainProviderConfig } from '../src/index.ts';
import { FakeEgressClient, testContext, type CannedResponse } from './helpers/fake-egress.ts';

const ME = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const EMPTY = { body: { status: '0', message: 'No transactions found', result: [] } };
const config = (options: Record<string, unknown>): ChainProviderConfig => ({
  id: 'etherscan-test',
  kind: 'etherscan',
  sourceId: 'etherscan_v2',
  baseUrl: 'https://etherscan.example.test/v2/api',
  chains: ['evm:1'],
  priority: 1,
  options,
});
const row = (block: number, hash: string, over: Record<string, string> = {}) => ({
  blockNumber: String(block),
  timeStamp: String(1_790_000_000 + block),
  hash,
  from: OTHER,
  to: ME,
  value: '1000000000000000000',
  isError: '0',
  ...over,
});
const ok = (result: unknown[]): CannedResponse => ({ body: { status: '1', message: 'OK', result } });

function etherscan(stream: string, pages: (p: URLSearchParams) => CannedResponse): FakeEgressClient {
  return new FakeEgressClient((r: EgressRequest) => {
    const p = new URL(r.url).searchParams;
    const action = p.get('action');
    if (action === 'eth_blockNumber') return { body: { jsonrpc: '2.0', id: 1, result: '0x100000' } };
    if (action === 'eth_getCode') return { body: { jsonrpc: '2.0', id: 1, result: '0x' } };
    if (action === 'balance') return { body: { status: '1', message: 'OK', result: '0' } };
    return action === stream ? pages(p) : EMPTY;
  });
}

async function fetchAll(http: FakeEgressClient, options: Record<string, unknown>) {
  return runChainFetch(
    [{ address: { chain: 'evm:1', address: ME } }],
    createChainProviderRegistry([config(options)], { env: {} }),
    testContext(http),
    {
      enabledSources: ['etherscan_v2'],
    },
  );
}

describe('transfers without a log index', () => {
  it('keeps internal transfers of one transaction that straddle a page boundary', async () => {
    const tx = `0x${'7'.repeat(64)}`;
    const http = etherscan('txlistinternal', (p) => {
      if (p.get('page') === '1') return ok([row(10, tx, { traceId: '0_1', value: '1000000000000000000' })]);
      if (p.get('page') === '2') return ok([row(10, tx, { traceId: '0_2', value: '2000000000000000000' })]);
      return EMPTY;
    });
    const result = await fetchAll(http, { pageSize: 1 });
    expect(result.transfers.map((t) => t.amount).toSorted()).toEqual(['1', '2']);
  });

  it('keeps token rows without a log index on separate pages, and de-duplicates the same row read twice', async () => {
    const tx = `0x${'8'.repeat(64)}`;
    const token = {
      contractAddress: '0x00000000000000000000000000000000000000c3',
      tokenSymbol: 'TKN',
      tokenDecimal: '0',
    };
    const http = etherscan('tokentx', (p) => {
      if (p.get('page') === '1') return ok([row(11, tx, { ...token, value: '5' })]);
      if (p.get('page') === '2') return ok([row(11, tx, { ...token, value: '7' })]);
      if (p.get('page') === '3')
        return ok([row(11, tx, { ...token, value: '7' }), row(12, `0x${'9'.repeat(64)}`, token)]);
      return EMPTY;
    });
    const result = await fetchAll(http, { pageSize: 1 });
    expect(result.transfers.map((t) => t.amount).toSorted()).toEqual(['1000000000000000000', '5', '7']);
  });
});

describe('dense blocks', () => {
  it('restarts the window at a dense later block and keeps the earlier pages', async () => {
    // window of 4 rows: blocks 1–2, then a page made only of block 5, then the rest of block 5
    const http = etherscan('txlist', (p) => {
      const start = Number(p.get('startblock'));
      const page = Number(p.get('page'));
      if (start === 0 && page === 1) return ok([row(1, '0x01'), row(2, '0x02')]);
      if (start === 0 && page === 2) return ok([row(5, '0x5a'), row(5, '0x5b')]);
      if (start === 5 && page === 1) return ok([row(5, '0x5a'), row(5, '0x5b')]);
      if (start === 5 && page === 2) return ok([row(5, '0x5c')]);
      return EMPTY;
    });
    const result = await fetchAll(http, { pageSize: 2, windowRows: 4 });
    expect(result.transfers.map((t) => t.txHash)).toEqual(['0x01', '0x02', '0x5a', '0x5b', '0x5c']);
    expect(result.outcomes[0]?.status).toBe('ok');
  });

  it('marks the listing truncated when one block fills a whole window, keeping what was read', async () => {
    const http = etherscan('txlist', (p) => {
      const start = Number(p.get('startblock'));
      const page = Number(p.get('page'));
      if (start === 0 && page === 1) return ok([row(1, '0x01'), row(2, '0x02')]);
      if (start === 0 && page === 2) return ok([row(3, '0x3a'), row(3, '0x3b')]);
      if (start === 3 && page === 1) return ok([row(3, '0x3a'), row(3, '0x3b')]);
      if (start === 3 && page === 2) return ok([row(3, '0x3c'), row(3, '0x3d')]);
      return EMPTY;
    });
    const result = await fetchAll(http, { pageSize: 2, windowRows: 4 });
    expect(result.transfers.map((t) => t.txHash)).toEqual(['0x01', '0x02', '0x3a', '0x3b', '0x3c', '0x3d']);
    expect(result.outcomes[0]?.status).toBe('truncated');
  });
});
