/**
 * Selections the chain stage makes over fetched chain data (synthetic transactions and outcomes).
 */
import type { ChainFetchOutcome } from '@olcys/chain-adapters';
import type { AddressRef, NormalizedTransfer, UtxoTransaction } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { incompleteHistories, isOwnStatement, transfersOf } from '../src/chain-data.ts';

const FETCH = '019a0000-0000-7000-8000-000000000001';
const BTC = { chain: 'bitcoin', symbol: 'BTC', decimals: 8 } as const;

function btcTransfer(txHash: string, index: number, from: string, to: string): NormalizedTransfer {
  return {
    chain: 'bitcoin',
    txHash,
    index,
    blockHeight: 100,
    blockTime: '2026-01-01T00:00:00Z',
    from,
    to,
    asset: BTC,
    amount: '0.1',
    kind: 'native',
    fetchId: FETCH,
  };
}

function utxoTx(txid: string, inputs: string[], outputs: string[]): UtxoTransaction {
  return {
    chain: 'bitcoin',
    txid,
    blockHeight: 100,
    inputs: inputs.map((address, vout) => ({ address, value: '0.5', prevTxid: `prev-${txid}`, vout })),
    outputs: outputs.map((address, n) => ({ address, value: '0.1', n })),
    fetchId: FETCH,
  };
}

describe('transfersOf', () => {
  const me: AddressRef = { chain: 'bitcoin', address: 'bc1q-synthetic-me' };

  it('gives a co-spending Bitcoin address the payments of its transactions, without its change', () => {
    // "other" is the first input, so the account-style view shows it as the sender of the whole transaction.
    const cospend = utxoTx('tx-cospend', ['bc1q-synthetic-other', me.address], ['bc1q-synthetic-shop', me.address]);
    const received = utxoTx('tx-in', ['bc1q-synthetic-payer'], [me.address]);
    const unrelated = utxoTx('tx-unrelated', ['bc1q-synthetic-payer'], ['bc1q-synthetic-third']);
    const transfers = [
      btcTransfer('tx-cospend', 0, 'bc1q-synthetic-other', 'bc1q-synthetic-shop'),
      btcTransfer('tx-cospend', 1, 'bc1q-synthetic-other', me.address),
      btcTransfer('tx-in', 0, 'bc1q-synthetic-payer', me.address),
      btcTransfer('tx-unrelated', 0, 'bc1q-synthetic-payer', 'bc1q-synthetic-third'),
    ];
    const mine = transfersOf(me, transfers, [cospend, received, unrelated]);
    expect(mine.map((t) => `${t.txHash}:${t.index}`)).toEqual(['tx-cospend:0', 'tx-in:0']);
  });

  it('falls back to the endpoints without UTXO data and compares EVM addresses case-insensitively', () => {
    const btc = transfersOf(me, [btcTransfer('tx-out', 0, me.address, 'bc1q-synthetic-shop')], []);
    expect(btc).toHaveLength(1);
    const evm: AddressRef = { chain: 'evm:1', address: '0xabc0000000000000000000000000000000000001' };
    const eth = { chain: 'evm:1', symbol: 'ETH', decimals: 18 } as const;
    const transfers: NormalizedTransfer[] = [
      { ...btcTransfer('0x01', 0, '0xABC0000000000000000000000000000000000001', '0xdef'), chain: 'evm:1', asset: eth },
      { ...btcTransfer('0x02', 0, '0xdef', '0x123'), chain: 'evm:1', asset: eth },
      {
        ...btcTransfer('0x03', 0, '0xabc0000000000000000000000000000000000001', '0xdef'),
        chain: 'evm:137',
        asset: eth,
      },
    ];
    expect(transfersOf(evm, transfers, []).map((t) => t.txHash)).toEqual(['0x01']);
  });
});

function outcome(
  address: string,
  chain: ChainFetchOutcome['chain'],
  status: ChainFetchOutcome['status'],
  providerId?: string,
): ChainFetchOutcome {
  return { address: { chain, address }, chain, status, pages: 0, items: 0, ...(providerId ? { providerId } : {}) };
}

describe('incompleteHistories', () => {
  it('is undefined when every history is complete, including a provider that failed over', () => {
    expect(
      incompleteHistories([
        outcome('bc1q-a', 'bitcoin', 'blocked', 'mempool'),
        outcome('bc1q-a', 'bitcoin', 'ok', 'blockstream'),
        outcome('bc1q-b', 'bitcoin', 'not_found', 'mempool'),
      ]),
    ).toBeUndefined();
  });

  it('counts every missing or cut-short history, naming chains without an enabled provider', () => {
    expect(
      incompleteHistories([
        outcome('T-a', 'tron', 'unsupported'),
        outcome('T-b', 'tron', 'unsupported'),
        outcome('0xa', 'evm:1', 'truncated', 'etherscan'),
        outcome('0xb', 'evm:1', 'replay_miss', 'etherscan'),
        outcome('0xc', 'evm:1', 'egress_denied', 'etherscan'),
        outcome('bc1q-c', 'bitcoin', 'ok', 'mempool'),
      ]),
    ).toBe(
      '5 address(es): tron no enabled provider (2), evm:1 truncated (1), evm:1 replay_miss (1), evm:1 egress_denied (1)',
    );
  });
});

describe('isOwnStatement', () => {
  it('needs an owner cue and no cue that the address is someone else’s', () => {
    expect(isOwnStatement(['first_person_owner'])).toBe(true);
    expect(isOwnStatement(['exchange_deposit', 'payment_request'])).toBe(true);
    expect(isOwnStatement(['first_person_owner', 'quote'])).toBe(false);
    expect(isOwnStatement(['exchange_deposit', 'warning'])).toBe(false);
    expect(isOwnStatement(['first_person_owner', 'scam_report'])).toBe(false);
    expect(isOwnStatement(['first_person_owner', 'listing'])).toBe(false);
    expect(isOwnStatement(['donation'])).toBe(false);
  });
});
