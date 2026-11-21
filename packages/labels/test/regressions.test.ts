/**
 * Regression tests for review findings on A4: transfers stay on the candidate's chain (`evm:unknown` only through the
 * explicit resolution), and each pair keeps the hot wallet its own forward reached. Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressLabel, NormalizedTransfer } from '@olcys/core';
import { fromBaseUnits, newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CURATED_DATASET,
  evaluateExclusions,
  loadDenyList,
  loadExclusionRules,
  loadLabelDataset,
  MemoryLabelLookup,
  type ExclusionDeps,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const slots = (JSON.parse(read('fixtures/persona/manifest.json')) as { addresses: Record<string, { address: string }> })
  .addresses;
const lower = (slot: string): string => (slots[slot]?.address ?? '').toLowerCase();
const demoLabels = loadLabelDataset(read('fixtures/labels/demo-curated.json'), DEMO_CURATED_DATASET, {
  retrievedAt: '2026-11-21T12:00:00Z',
});
const deps = (labels: AddressLabel[]): ExclusionDeps => ({
  labels: new MemoryLabelLookup(labels),
  rules: loadExclusionRules(read('config/rules/exclusion.v1.yaml')),
  denyList: loadDenyList(read('config/rules/deny-list.v1.yaml')),
  runId: newId(),
});
const OTHER_EXCHANGE = '0x00000000000000000000000000000000000000e2';
const ME = '0x00000000000000000000000000000000000000a1';

function eth(txHash: string, from: string, to: string, wei: string, block: number): NormalizedTransfer {
  return {
    chain: 'evm:1',
    txHash,
    blockHeight: block,
    blockTime: '2026-11-03T10:00:00.000Z',
    from,
    to,
    asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
    amount: fromBaseUnits(wei, 18),
    kind: 'native',
    fetchId: 'f',
  };
}

const deposit = [
  eth('0xr0', '0x00000000000000000000000000000000000000c0', ME, '1500000000000000000', 100),
  eth('0xf0', ME, lower('HOT-1'), '1499559000000000000', 134),
];

describe('A4 regressions', () => {
  it('evaluates transfers only on the candidate’s chain; evm:unknown only through the explicit resolution', async () => {
    const d = deps(demoLabels);
    expect(
      await evaluateExclusions({ address: { chain: 'evm:137', address: ME }, transfers: deposit, published: true }, d),
    ).toEqual([]);
    const unknown = { chain: 'evm:unknown' as const, address: ME };
    expect(await evaluateExclusions({ address: unknown, transfers: deposit, published: true }, d)).toEqual([]);
    const resolved = await evaluateExclusions(
      { address: unknown, resolved: { chain: 'evm:1', address: ME }, transfers: deposit, published: true },
      d,
    );
    expect(resolved.map((x) => [x.ruleId, x.address.chain])).toEqual([['A4', 'evm:unknown']]);
  });

  it('keeps the hot wallet of each pair when deposits are forwarded to different exchanges', async () => {
    const hot = demoLabels.find((l) => l.address.address === lower('HOT-1')) as AddressLabel;
    const second: AddressLabel = {
      ...hot,
      id: newId(),
      address: { chain: 'evm:1', address: OTHER_EXCHANGE },
      entity: 'Giełda Druga (SYNTHETIC)',
    };
    const transfers = [
      ...deposit,
      eth('0xr1', '0x00000000000000000000000000000000000000c1', ME, '2000000000000000000', 200),
      eth('0xf1', ME, OTHER_EXCHANGE, '1999000000000000000', 205),
    ];
    const [a4] = await evaluateExclusions(
      { address: { chain: 'evm:1', address: ME }, transfers, published: false },
      deps([...demoLabels, second]),
    );
    expect(a4?.evidence.pairs?.map((p) => [p.receiveTx, p.forwardsTo?.entity])).toEqual([
      ['0xr0', 'Giełda Testowa (SYNTHETIC)'],
      ['0xr1', 'Giełda Druga (SYNTHETIC)'],
    ]);
    expect(a4?.evidence.labelIds?.toSorted()).toEqual([hot.id, second.id].toSorted());
  });
});
