import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressLabel, NormalizedTransfer } from '@olcys/core';
import { fromBaseUnits, newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  classifyAddressType,
  decidingAllowed,
  DEMO_CURATED_DATASET,
  effectiveOutcome,
  evaluateExclusions,
  loadDenyList,
  loadExclusionRules,
  loadLabelDataset,
  MemoryLabelLookup,
  prescreenExclusions,
  type ExclusionDeps,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('fixtures/persona/manifest.json')) as {
  addresses: Record<string, { chain: string; address: string }>;
  chain: { contractCode: Record<string, string> };
};
const slot = (name: string): string => manifest.addresses[name]?.address ?? '';
const lower = (name: string): string => slot(name).toLowerCase();

const demoLabels = loadLabelDataset(read('fixtures/labels/demo-curated.json'), DEMO_CURATED_DATASET, {
  retrievedAt: '2026-11-21T12:00:00Z',
});
const rules = loadExclusionRules(read('config/rules/exclusion.v1.yaml'));
const denyList = loadDenyList(read('config/rules/deny-list.v1.yaml'));
const deps = (labels: AddressLabel[] = demoLabels): ExclusionDeps => ({
  labels: new MemoryLabelLookup(labels),
  rules,
  denyList,
  runId: newId(),
});

/** ETH-1 history exactly as served by the fixture site (Etherscan txlist rows). */
function eth1Transfers(): NormalizedTransfer[] {
  const rows = (
    JSON.parse(read(`apps/fixture-site/public/shared/chain/etherscan/${lower('ETH-1')}/txlist.json`)) as {
      result: { blockNumber: string; timeStamp: string; hash: string; from: string; to: string; value: string }[];
    }
  ).result;
  return rows.map((r) => ({
    chain: 'evm:1',
    txHash: r.hash,
    blockHeight: Number(r.blockNumber),
    blockTime: new Date(Number(r.timeStamp) * 1000).toISOString(),
    from: r.from,
    to: r.to,
    asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
    amount: fromBaseUnits(r.value, 18),
    kind: 'native',
    fetchId: 'f-eth1',
  }));
}

const usdt = (txHash: string, from: string, to: string, amount: string, at: string): NormalizedTransfer => ({
  chain: 'tron',
  txHash,
  index: 0,
  blockHeight: 0,
  blockTime: at,
  from,
  to,
  asset: { chain: 'tron', symbol: 'USDT', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  amount,
  kind: 'token',
  fetchId: 'f-tron',
});

const decisionOf = (
  ruleId: 'A1' | 'A2' | 'A3' | 'A4' | 'A8',
  outcome: 'excluded' | 'reclassified' | 'kept',
): Parameters<typeof effectiveOutcome>[0][number] =>
  ({ id: ruleId, ruleId, outcome }) as Parameters<typeof effectiveOutcome>[0][number];

describe('demo label dataset', () => {
  it('loads with deciding provenance and canonical (lower-case) EVM addresses', () => {
    expect(demoLabels).toHaveLength(3);
    const hot = demoLabels.find((l) => l.address.address === lower('HOT-1'));
    expect(hot).toMatchObject({ entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' });
    expect(hot?.provenance).toMatchObject({
      datasetId: 'demo-curated',
      version: 'v1',
      sourceType: 'por_file',
      deciding: true,
      license: 'CC0-1.0',
      synthetic: true,
    });
  });

  it('applies the licence policy and names failing entries', () => {
    expect(decidingAllowed({ licenseClass: 'open', sourceType: 'por_file' })).toBe(true);
    expect(decidingAllowed({ licenseClass: 'publisher_disclosure', sourceType: 'graphsense_tagpack' })).toBe(true);
    expect(decidingAllowed({ licenseClass: 'open', sourceType: 'etherscan_derived' })).toBe(false);
    for (const licenseClass of ['non_commercial', 'source_available', 'proprietary', 'unknown'] as const) {
      expect(decidingAllowed({ licenseClass, sourceType: 'por_file' })).toBe(false);
    }
    const file = read('fixtures/labels/demo-curated.json');
    expect(() =>
      loadLabelDataset(file, { ...DEMO_CURATED_DATASET, licenseClass: 'non_commercial' }, { retrievedAt: 'x' }),
    ).toThrow(/dataset_licence_refused/);
    const broken = file.replace('"category": "defi_dex"', '"category": "casino"');
    expect(() => loadLabelDataset(broken, DEMO_CURATED_DATASET, { retrievedAt: 'x' })).toThrow(/labels\[2\]\.category/);
  });

  it('matches evm:unknown queries on any EVM chain and never across chain families', async () => {
    const lookup = new MemoryLabelLookup(demoLabels);
    expect(await lookup.labelsFor({ chain: 'evm:unknown', address: slot('HOT-1') })).toHaveLength(1);
    expect(await lookup.labelsFor({ chain: 'bitcoin', address: lower('HOT-1') })).toEqual([]);
  });

  it('filters by validity at a time and ranks by dataset trust order before confidence', async () => {
    const base = demoLabels[0] as AddressLabel;
    const at = (over: Partial<AddressLabel>, provenance: Partial<AddressLabel['provenance']> = {}): AddressLabel => ({
      ...base,
      id: newId(),
      ...over,
      provenance: { ...base.provenance, ...provenance },
    });
    const closed = at({ attributes: { activeTo: '2026-08-21' } });
    const lookup = new MemoryLabelLookup([
      closed,
      at({ confidence: 90 }, { sourceType: 'etherscan_derived', deciding: false }),
      at({ confidence: 80 }, { sourceType: 'graphsense_tagpack' }),
    ]);
    const all = await lookup.labelsFor(base.address);
    expect(all.map((l) => l.provenance.sourceType)).toEqual(['por_file', 'graphsense_tagpack', 'etherscan_derived']);
    expect(await lookup.labelsFor(base.address, '2026-08-21T23:00:00Z')).toHaveLength(3);
    expect((await lookup.labelsFor(base.address, '2026-08-22T00:00:00Z')).some((l) => l.id === closed.id)).toBe(false);
  });
});

describe('exclusion rules on the synthetic persona', () => {
  it('A1: the labelled exchange hot wallet HOT-1 is excluded (also as evm:unknown)', async () => {
    const decisions = await evaluateExclusions(
      { address: { chain: 'evm:unknown', address: slot('HOT-1') }, transfers: [], published: false },
      deps(),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ ruleId: 'A1', outcome: 'excluded', rulesVersion: 'exclusion.v1' });
    expect(decisions[0]?.evidence.labelIds).toEqual([demoLabels.find((l) => l.address.address === lower('HOT-1'))?.id]);
  });

  it('A1 never decides on corroborating-only or non-service labels', async () => {
    const hot = demoLabels.find((l) => l.address.address === lower('HOT-1')) as AddressLabel;
    for (const label of [
      { ...hot, provenance: { ...hot.provenance, sourceType: 'etherscan_derived' as const, deciding: false } },
      { ...hot, category: 'sanctioned_entity' as const },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const decisions = await prescreenExclusions(hot.address, deps([label]));
      expect(decisions).toEqual([]);
    }
  });

  it('A4: ETH-1 forwards the 1.5 ETH deposit to HOT-1 → CUSTODIAL_EXCHANGE with a B1 seed', async () => {
    const transfers = eth1Transfers();
    const decisions = await evaluateExclusions(
      {
        address: { chain: 'evm:1', address: slot('ETH-1') },
        classification: classifyAddressType({ chain: 'evm:1', address: lower('ETH-1') }, '0x', ['f-code']),
        transfers,
        published: true,
      },
      deps(),
    );
    expect(decisions).toHaveLength(1);
    const a4 = decisions[0];
    expect(a4).toMatchObject({
      ruleId: 'A4',
      outcome: 'reclassified',
      relation: 'CUSTODIAL_EXCHANGE',
      emitsCashOut: 'B1',
      address: { chain: 'evm:1', address: lower('ETH-1') },
    });
    expect(a4?.evidence).toMatchObject({
      kappa: 0.957013,
      kycLead: true,
      txHashes: [slot('TX-DECOY'), transfers[1]?.txHash],
      forwardsTo: { address: lower('HOT-1'), entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' },
      params: { tauBlocks: 3200, alpha: '0.01', clock: 'blocks', distinctSenders: 1 },
    });
    expect(a4?.evidence.pairs?.[0]).toMatchObject({ amountIn: '1.5', amountOut: '1.499559', delta: 134 });
  });

  it('A4 on TRON counts tau in seconds (an exchange deposit address sweeping 2.5 h later)', async () => {
    const dep = slot('TRON-DEP');
    const decisions = await evaluateExclusions(
      {
        address: { chain: 'tron', address: dep },
        transfers: [
          usdt('t1', slot('TRON-1'), dep, '3000', '2026-08-22T09:00:00.000Z'),
          usdt('t2', dep, slot('TRON-HOT'), '3000', '2026-08-22T11:30:00.000Z'),
        ],
        published: false,
      },
      deps(),
    );
    expect(decisions[0]).toMatchObject({ ruleId: 'A4', evidence: { kappa: 0.882813, kycLead: false } });
    expect(decisions[0]?.evidence.params).toMatchObject({ tauSeconds: 38_400, clock: 'seconds' });
  });

  it('A2: CONTRACT-1 has bytecode and is excluded; A3 keeps an EIP-7702 delegated account', async () => {
    const contract = { chain: 'evm:1' as const, address: lower('CONTRACT-1') };
    const code = manifest.chain.contractCode['CONTRACT-1'];
    const excluded = await evaluateExclusions(
      {
        address: contract,
        classification: classifyAddressType(contract, code, ['f']),
        transfers: [],
        published: false,
      },
      deps(),
    );
    expect(excluded.map((d) => [d.ruleId, d.outcome])).toEqual([['A2', 'excluded']]);
    expect(excluded[0]?.evidence.codePrefix).toBe('0x60806040');

    const delegated = classifyAddressType(contract, '0xef0100' + 'ab'.repeat(20));
    expect(delegated).toMatchObject({ type: 'delegated_eoa', delegate: '0x' + 'ab'.repeat(20) });
    const kept = await evaluateExclusions(
      { address: contract, classification: delegated, transfers: [], published: false },
      deps(),
    );
    expect(kept.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'kept']]);
    expect(classifyAddressType(contract, '0x').type).toBe('eoa');
  });

  it('A8: the BIP-173 documentation vector D2, burn addresses and token contracts', async () => {
    const d2 = await evaluateExclusions(
      { address: { chain: 'bitcoin', address: slot('D2') }, transfers: [], published: true },
      deps(),
    );
    expect(d2.map((d) => [d.ruleId, d.outcome, d.evidence.denyList?.kind])).toEqual([
      ['A8', 'excluded', 'test_vector'],
    ]);
    const dead = { chain: 'evm:unknown' as const, address: '0x000000000000000000000000000000000000dEaD' };
    expect((await prescreenExclusions(dead, deps()))[0]?.evidence.denyList?.kind).toBe('burn');
    const usdtContract = { chain: 'evm:137' as const, address: '0xdac17f958d2ee523a2206206994597c13d831ec7' };
    expect(denyList.match(usdtContract)?.kind).toBe('token_contract');
    expect(denyList.match({ chain: 'bitcoin', address: slot('BTC-1') })).toBeUndefined();
  });

  it('combines decisions by precedence', () => {
    expect(effectiveOutcome([decisionOf('A2', 'excluded'), decisionOf('A4', 'reclassified')]).decisive?.ruleId).toBe(
      'A4',
    );
    expect(effectiveOutcome([decisionOf('A4', 'reclassified'), decisionOf('A8', 'excluded')]).outcome).toBe('excluded');
    expect(effectiveOutcome([decisionOf('A3', 'kept')]).outcome).toBe('kept');
    expect(effectiveOutcome([]).outcome).toBe('none');
  });
});
