/**
 * Regression tests: a Bitcoin payment read from the sender's and the recipient's history is one transfer, and a row
 * with unsupported token decimals is skipped and reported without aborting the fetch. Synthetic placeholders only.
 */
import type { EgressRequest } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  createChainProviderRegistry,
  mapTrc20Items,
  runChainFetch,
  USDT_TRC20,
  type ChainProviderConfig,
  type SkipReason,
} from '../src/index.ts';
import { FakeEgressClient, routes, testContext } from './helpers/fake-egress.ts';

const A = 'bc1qsyntheticsendera';
const B = 'bc1qsyntheticsenderb';
const C = 'bc1qsyntheticrecipientc';
const esplora: ChainProviderConfig = {
  id: 'esplora-test',
  kind: 'esplora',
  sourceId: 'mempool_space',
  baseUrl: 'https://esplora.example.test/api',
  chains: ['bitcoin'],
  priority: 1,
};
const out = (address: string, value: number) => ({
  scriptpubkey_address: address,
  scriptpubkey_type: 'v0_p2wpkh',
  value,
});
// A (smaller input) is listed first, B (larger) second: the sender must not depend on whose history is read.
const payment = {
  txid: 'e'.repeat(64),
  vin: [
    { txid: '1'.repeat(64), vout: 0, prevout: out(A, 1_000_000) },
    { txid: '2'.repeat(64), vout: 0, prevout: out(B, 9_000_000) },
  ],
  vout: [out(C, 9_990_000)],
  fee: 10_000,
  status: { confirmed: true, block_height: 900_000, block_hash: 'b'.repeat(64), block_time: 1_790_000_000 },
};
const stats = {
  chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
};

describe('Bitcoin payments in merged histories', () => {
  it('gives the recipient exactly one incoming transfer when both histories are fetched', async () => {
    const http = new FakeEgressClient(
      routes({
        '/blocks/tip/height': { body: '900100' },
        [`/address/${A}/txs`]: { body: [payment] },
        [`/address/${C}/txs`]: { body: [payment] },
        [`/address/${A}`]: { body: stats },
        [`/address/${C}`]: { body: stats },
      }),
    );
    const result = await runChainFetch(
      [{ address: { chain: 'bitcoin', address: A } }, { address: { chain: 'bitcoin', address: C } }],
      createChainProviderRegistry([esplora]),
      testContext(http),
      { enabledSources: ['mempool_space'] },
    );
    const toC = result.transfers.filter((t) => t.to === C && t.txHash === payment.txid);
    expect(toC).toHaveLength(1);
    expect(toC[0]).toMatchObject({ from: A, amount: '0.0999', index: 0 });
  });
});

const item = (id: string, decimals: number | string) => ({
  transaction_id: id,
  token_info: { symbol: 'USDT', address: USDT_TRC20, decimals },
  block_timestamp: 1_790_000_000_000,
  from: 'TSyntheticFrom0000000000000000000',
  to: 'TSyntheticTo000000000000000000000',
  type: 'Transfer',
  value: '1000000',
});

describe('unsupported token decimals', () => {
  const token = { contractAddress: '0x00000000000000000000000000000000000000c3', tokenSymbol: 'TKN' };
  const row = (hash: string, tokenDecimal: string, value = '1000000') => ({
    blockNumber: '100',
    timeStamp: '1790000000',
    hash,
    from: '0x00000000000000000000000000000000000000b2',
    to: '0x00000000000000000000000000000000000000a1',
    value,
    tokenDecimal,
    ...token,
  });

  it('skips the row, reports it and keeps the rest of the listing', async () => {
    const http = new FakeEgressClient((r: EgressRequest) => {
      const action = new URL(r.url).searchParams.get('action');
      if (action === 'eth_blockNumber') return { body: { jsonrpc: '2.0', id: 1, result: '0x100000' } };
      if (action === 'eth_getCode') return { body: { jsonrpc: '2.0', id: 1, result: '0x' } };
      if (action === 'balance') return { body: { status: '1', message: 'OK', result: '0' } };
      if (action === 'tokentx') {
        return {
          body: { status: '1', message: 'OK', result: [row('0x01', '6'), row('0x02', '78'), row('0x03', '6')] },
        };
      }
      return { body: { status: '0', message: 'No transactions found', result: [] } };
    });
    const result = await runChainFetch(
      [{ address: { chain: 'evm:1', address: '0x00000000000000000000000000000000000000a1' } }],
      createChainProviderRegistry(
        [{ ...esplora, id: 'etherscan-test', kind: 'etherscan', sourceId: 'etherscan_v2', chains: ['evm:1'] }],
        { env: {} },
      ),
      testContext(http),
      { enabledSources: ['etherscan_v2'] },
    );
    expect(result.transfers.map((t) => t.txHash)).toEqual(['0x01', '0x03']);
    expect(result.outcomes[0]).toMatchObject({
      status: 'ok',
      skipped: [{ txHash: '0x02', reason: 'unsupported_decimals' }],
    });
  });

  it('skips TRC-20 items the converter cannot represent', () => {
    const skipped: { txHash: string; reason: SkipReason }[] = [];
    const items = mapTrc20Items([item('t1', 6), item('t2', 80), item('t3', 'x')], 'f', skipped);
    expect(items.map((t) => t.txHash)).toEqual(['t1']);
    expect(skipped).toEqual([
      { txHash: 't2', reason: 'unsupported_decimals' },
      { txHash: 't3', reason: 'unsupported_decimals' },
    ]);
  });
});
