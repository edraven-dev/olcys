import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressLabel, AddressRef, AddressTypeClassification, NormalizedTransfer } from '@olcys/core';
import { fromBaseUnits, newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  decidingAllowed,
  DEMO_CURATED_DATASET,
  effectiveOutcome,
  evaluateExclusions,
  loadDenyList,
  loadDelegateRegistry,
  loadExclusionRules,
  loadLabelDataset,
  MemoryLabelLookup,
  prescreenExclusions,
  type ClassifierDeps,
  type ExclusionDeps,
} from '../src/index.ts';
import { ctx } from './helpers.ts';

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
const delegates = loadDelegateRegistry(read('config/labels/eip7702-delegates.v1.yaml'));
const deps = (labels: AddressLabel[] = demoLabels): ExclusionDeps => ({
  labels: new MemoryLabelLookup(labels),
  rules,
  denyList,
  runId: newId(),
  delegates,
});
/** Classification from already fetched code, without a provider (no probes). */
const classifyCode = (address: AddressRef, code: string, fetchId = 'f-code') => {
  const local: ClassifierDeps = {
    labels: new MemoryLabelLookup([]),
    safeSingletons: new Map(),
    entryPoints: new Set(),
    code: { code, fetchId },
  };
  return classifyAddress(address, local, ctx);
};

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
        classification: await classifyCode({ chain: 'evm:1', address: lower('ETH-1') }, '0x'),
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
    const code = manifest.chain.contractCode['CONTRACT-1'] ?? '';
    const excluded = await evaluateExclusions(
      {
        address: contract,
        classification: await classifyCode(contract, code, 'f'),
        transfers: [],
        published: false,
      },
      deps(),
    );
    expect(excluded.map((d) => [d.ruleId, d.outcome])).toEqual([['A2', 'excluded']]);
    expect(excluded[0]?.evidence).toMatchObject({
      codePrefix: '0x60806040',
      codeBytes: (code.length - 2) / 2,
      fetchIds: ['f'],
    });

    const delegated = await classifyCode(contract, '0xef0100' + 'ab'.repeat(20));
    expect(delegated).toMatchObject({ type: 'delegated_eoa', delegate: '0x' + 'ab'.repeat(20) });
    const kept = await evaluateExclusions(
      { address: contract, classification: delegated, transfers: [], published: false },
      deps(),
    );
    expect(kept.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'kept']]);
    expect(kept[0]?.evidence).toMatchObject({
      delegate: '0x' + 'ab'.repeat(20),
      codePrefix: '0xef0100',
      codeBytes: 23,
    });
    expect(kept[0]?.evidence.delegateInfo).toBeUndefined();
    expect((await classifyCode(contract, '0x')).type).toBe('eoa');
  });

  it('records the network the chain data of an evm:unknown candidate was fetched on', async () => {
    const candidate = { chain: 'evm:unknown' as const, address: slot('CONTRACT-1') };
    const resolved = { chain: 'evm:1' as const, address: lower('CONTRACT-1') };
    const code = manifest.chain.contractCode['CONTRACT-1'] ?? '';
    const decisions = await evaluateExclusions(
      {
        address: candidate,
        resolved,
        classification: await classifyCode(resolved, code),
        transfers: [],
        published: false,
      },
      deps(),
    );
    expect(decisions.map((d) => [d.ruleId, d.outcome, d.address.chain, d.resolved])).toEqual([
      ['A2', 'excluded', 'evm:unknown', resolved],
    ]);
    // A candidate on a known network needs no such record.
    const direct = await evaluateExclusions(
      { address: resolved, classification: await classifyCode(resolved, code), transfers: [], published: false },
      deps(),
    );
    expect(direct[0]).not.toHaveProperty('resolved');
  });

  it('A2 keeps Safe and ERC-4337 accounts: personal smart accounts stay attributable', async () => {
    const address = { chain: 'evm:1' as const, address: '0x' + '5a'.repeat(20) };
    const base = { address, codePrefix: '0x608060', codeSize: 171, fetchIds: ['f1', 'f2'] };
    const safe: AddressTypeClassification = {
      ...base,
      type: 'safe',
      safeMasterCopy: '0x41675c099f32341bf84bfc5382af534df5c7461a',
    };
    const account: AddressTypeClassification = {
      ...base,
      type: 'erc4337_account',
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
    };
    for (const classification of [safe, account]) {
      // oxlint-disable-next-line no-await-in-loop
      const decisions = await evaluateExclusions({ address, classification, transfers: [], published: true }, deps());
      expect(decisions.map((d) => [d.ruleId, d.outcome])).toEqual([['A2', 'kept']]);
      expect(effectiveOutcome(decisions).outcome).toBe('kept');
      expect(decisions[0]?.evidence).toMatchObject({ fetchIds: ['f1', 'f2'], codeBytes: 171 });
    }
    const [safeDecision] = await evaluateExclusions(
      { address, classification: safe, transfers: [], published: true },
      deps(),
    );
    expect(safeDecision?.reason).toContain('0x41675c099f32341bf84bfc5382af534df5c7461a');
    // a token contract or a malformed delegation never counts as a personal account
    const token = await evaluateExclusions(
      { address, classification: { ...base, type: 'token_contract' }, transfers: [], published: true },
      deps(),
    );
    expect(token.map((d) => [d.ruleId, d.outcome])).toEqual([['A2', 'excluded']]);
    const malformed = await evaluateExclusions(
      {
        address,
        classification: await classifyCode(address, '0xef0100' + 'ab'.repeat(21)),
        transfers: [],
        published: true,
      },
      deps(),
    );
    expect(malformed).toEqual([]);
  });

  it('A3 flags a delegation to a known sweeper and names a known wallet implementation', async () => {
    const address = { chain: 'evm:1' as const, address: '0x' + '7a'.repeat(20) };
    const sweeper = [...delegates.values()].find((d) => d.kind === 'sweeper');
    expect(sweeper).toMatchObject({ chain: 'evm:1', synthetic: true });
    const drained = await classifyCode(address, `0xef0100${sweeper?.address.slice(2)}`);
    const flagged = await evaluateExclusions(
      { address, classification: drained, transfers: [], published: true },
      deps(),
    );
    expect(flagged.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'flagged']]);
    expect(flagged[0]?.evidence).toMatchObject({
      delegate: sweeper?.address,
      delegateInfo: { kind: 'sweeper', name: sweeper?.name, source: sweeper?.source },
    });
    expect(effectiveOutcome(flagged).outcome).toBe('flagged');

    // A wallet implementation valid on every EVM network: kept, with its name.
    const implementation = '0x' + 'c0'.repeat(20);
    const registry = loadDelegateRegistry(
      `version: x\ndelegates:\n  - { chain: evm:unknown, address: '${implementation}', kind: wallet_implementation, name: Wallet X, source: 'https://example.org/wallet-x' }\n`,
    );
    const onPolygon = { chain: 'evm:137' as const, address: address.address };
    const kept = await evaluateExclusions(
      {
        address: onPolygon,
        classification: await classifyCode(onPolygon, `0xef0100${implementation.slice(2)}`),
        transfers: [],
        published: true,
      },
      { ...deps(), delegates: registry },
    );
    expect(kept.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'kept']]);
    expect(kept[0]?.reason).toContain(`the delegate ${implementation} (wallet implementation "Wallet X")`);

    // The rule file decides: no flag and no recorded delegate when switched off.
    const quiet = await evaluateExclusions(
      { address, classification: drained, transfers: [], published: true },
      { ...deps(), rules: { ...rules, a3: { recordDelegate: false, flagKnownSweepers: false } } },
    );
    expect(quiet.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'kept']]);
    expect(quiet[0]?.evidence.delegate).toBeUndefined();
    expect(quiet[0]?.evidence.delegateInfo).toBeUndefined();
    expect(quiet[0]?.reason).not.toContain(sweeper?.address ?? '0x');
    // Flagging without recording: the warning stands, the delegate is not named in the decision.
    const unnamed = await evaluateExclusions(
      { address, classification: drained, transfers: [], published: true },
      { ...deps(), rules: { ...rules, a3: { recordDelegate: false, flagKnownSweepers: true } } },
    );
    expect(unnamed.map((d) => [d.ruleId, d.outcome])).toEqual([['A3', 'flagged']]);
    expect(unnamed[0]?.reason).not.toContain(sweeper?.name ?? 'SWEEPER');
    expect(unnamed[0]?.evidence).not.toHaveProperty('delegateInfo');
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
