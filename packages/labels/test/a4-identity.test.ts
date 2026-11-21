/**
 * Regression test: when one transaction moves several assets into a deposit address, the A4 pair records exactly
 * which transfer was forwarded (asset key, kind, index). Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedTransfer } from '@olcys/core';
import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CURATED_DATASET,
  evaluateExclusions,
  loadDenyList,
  loadExclusionRules,
  loadLabelDataset,
  MemoryLabelLookup,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const hot = (
  JSON.parse(read('fixtures/persona/manifest.json')) as { addresses: Record<string, { address: string }> }
).addresses['HOT-1']?.address.toLowerCase();
const ME = '0x00000000000000000000000000000000000000a1';
const SENDER = '0x00000000000000000000000000000000000000c1';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const base = { chain: 'evm:1' as const, blockTime: '2026-11-03T10:00:00.000Z', fetchId: 'f' };
const eth = { chain: 'evm:1' as const, symbol: 'ETH', decimals: 18 };
const usdc = { chain: 'evm:1' as const, symbol: 'USDC', decimals: 6, contract: USDC };

describe('A4 pair identity', () => {
  it('records the forwarded transfer of a multi-asset deposit', async () => {
    const transfers: NormalizedTransfer[] = [
      { ...base, txHash: '0xdep', blockHeight: 100, from: SENDER, to: ME, asset: eth, amount: '0.5', kind: 'native' },
      {
        ...base,
        txHash: '0xdep',
        index: 5,
        blockHeight: 100,
        from: SENDER,
        to: ME,
        asset: usdc,
        amount: '1000',
        kind: 'token',
      },
      {
        ...base,
        txHash: '0xsweep',
        index: 2,
        blockHeight: 110,
        from: ME,
        to: hot ?? '',
        asset: usdc,
        amount: '1000',
        kind: 'token',
      },
    ];
    const [a4] = await evaluateExclusions(
      { address: { chain: 'evm:1', address: ME }, transfers, published: false },
      {
        labels: new MemoryLabelLookup(
          loadLabelDataset(read('fixtures/labels/demo-curated.json'), DEMO_CURATED_DATASET, { retrievedAt: 'x' }),
        ),
        rules: loadExclusionRules(read('config/rules/exclusion.v1.yaml')),
        denyList: loadDenyList(read('config/rules/deny-list.v1.yaml')),
        runId: newId(),
      },
    );
    expect(a4?.evidence.pairs).toEqual([
      expect.objectContaining({
        receiveTx: '0xdep',
        forwardTx: '0xsweep',
        amountIn: '1000',
        assetKey: USDC,
        receiveKind: 'token',
        receiveIndex: 5,
        forwardKind: 'token',
        forwardIndex: 2,
      }),
    ]);
  });
});
