/**
 * End-to-end check of the chain analysis wiring on the synthetic persona: real egress client (offline mode) →
 * chain adapters against the in-process fixture site → address types → exclusion rules → activity, cash-out and fund
 * flows.
 * Reproduces `expected.v1.rejected` and `expected.v1.cashOut` of fixtures/persona/manifest.json. No network: the
 * fixture site runs on 127.0.0.1 and NBP rates are a synthetic stub.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyseAddress,
  createAssetRegistry,
  createSeriesPriceSource,
  createValuator,
  loadCashOutRules,
  loadCashOutScoreConfig,
  loadPriceDataset,
  planCounterpartyExpansion,
  type AddressAnalysis,
} from '@olcys/analytics';
import {
  createChainProviderRegistry,
  loadChainProviderConfig,
  runChainFetch,
  TipCache,
  withFixtureSite,
} from '@olcys/chain-adapters';
import type {
  AddressRef,
  AddressTypeClassification,
  BlobRef,
  EgressLogEntry,
  ExclusionDecision,
  FxRateSource,
  NormalizedTransfer,
  ProvenanceEnvelope,
  RunContext,
  SourceDescriptor,
} from '@olcys/core';
import { addressKey, newId } from '@olcys/core';
import { createEgressClient } from '@olcys/http';
import {
  DEMO_CURATED_DATASET,
  effectiveOutcome,
  evaluateExclusions,
  loadDelegateRegistry,
  loadDenyList,
  loadEntryPoints,
  loadExclusionRules,
  loadLabelDataset,
  loadSafeSingletons,
  MemoryLabelLookup,
  prescreenExclusions,
} from '@olcys/labels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { classifyFetched } from '../src/address-types.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('fixtures/persona/manifest.json')) as {
  hostPrefixes: Record<string, string>;
  addresses: Record<string, { chain: string; address: string }>;
  expected: {
    v1: { rejected: { slot: string; rule: string; relation?: string }[]; cashOut: { rule: string; slot: string }[] };
  };
};
const ref = (slot: string, chain?: string): AddressRef => {
  const entry = manifest.addresses[slot];
  return { chain: (chain ?? entry?.chain ?? 'bitcoin') as AddressRef['chain'], address: entry?.address ?? '' };
};

const CHAIN_SOURCES = ['mempool_space', 'etherscan_v2', 'trongrid'];
const TIP_PURPOSES = new Set(['bitcoin chain tip', 'evm chain tip', 'tron chain tip']);
const transfersOf = (a: AddressRef, transfers: readonly NormalizedTransfer[]): NormalizedTransfer[] =>
  transfers.filter((t) => t.chain === a.chain && [t.from, t.to].includes(a.address));

let site: FixtureServer;
const log: EgressLogEntry[] = [];
const envelopes: ProvenanceEnvelope[] = [];
const decisions: ExclusionDecision[] = [];
const analyses = new Map<string, AddressAnalysis>();
let types = new Map<string, AddressTypeClassification>();
/** The classification of a persona address, as fetched (EVM lower-case). */
const typeOf = (slot: string, chain?: string): AddressTypeClassification | undefined => {
  const a = ref(slot, chain);
  return types.get(addressKey(a.chain.startsWith('evm:') ? { ...a, address: a.address.toLowerCase() } : a));
};

beforeAll(async () => {
  site = await createFixtureServer({
    root: join(ROOT, 'apps', 'fixture-site', 'public'),
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: false,
  });
  const register = parseYaml(read('config/sources.yaml')) as {
    providers: Record<string, Omit<SourceDescriptor, 'id'>>;
  };
  // The register's pace applies in real runs; the test raises it so the suite stays fast.
  const enabled = CHAIN_SOURCES.map(
    (id) => ({ ...register.providers[id], id, rateLimit: { requests: 1000, perSeconds: 1 } }) as SourceDescriptor,
  );
  const blobs = new Map<string, Uint8Array>();
  const http = createEgressClient({
    mode: 'offline',
    enabledSources: enabled,
    toolVersion: 'test',
    blobs: {
      put: async (bytes: Uint8Array, mediaType: string): Promise<BlobRef> => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        blobs.set(sha256, bytes);
        return { sha256, bytes: bytes.byteLength, mediaType };
      },
      get: async (sha) => blobs.get(sha) ?? new Uint8Array(),
      has: async (sha) => blobs.has(sha),
    },
    sinks: { log: (e) => void log.push(e), provenance: (p) => void envelopes.push(p) },
  });
  const runId = newId();
  const ctx: RunContext = {
    runId,
    caseId: newId(),
    mode: 'offline',
    http,
    blobs: {
      put: async () => ({ sha256: '', bytes: 0, mediaType: '' }),
      get: async () => new Uint8Array(),
      has: async () => false,
    },
    clock: { now: () => new Date('2026-11-21T12:00:00Z') },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };

  // Composition as the run pipeline does it.
  const providers = withFixtureSite(
    loadChainProviderConfig(read('config/chain-providers.yaml'), register),
    site.url,
    manifest.hostPrefixes,
  );
  const registry = createChainProviderRegistry(providers, { env: {} });
  const labels = new MemoryLabelLookup(
    loadLabelDataset(read('fixtures/labels/demo-curated.json'), DEMO_CURATED_DATASET, {
      retrievedAt: '2026-11-21T12:00:00Z',
    }),
  );
  const rules = loadExclusionRules(read('config/rules/exclusion.v1.yaml'));
  const exclusionDeps = {
    labels,
    rules,
    denyList: loadDenyList(read('config/rules/deny-list.v1.yaml')),
    runId,
    delegates: loadDelegateRegistry(read('config/labels/eip7702-delegates.v1.yaml')),
  };

  // Candidates as the extractor reports them (HOT-1 and CONTRACT-1 without a chain marker).
  const candidates = [
    ref('BTC-1'),
    ref('ETH-1'),
    ref('ETH-2'),
    ref('HOT-1', 'evm:unknown'),
    ref('CONTRACT-1', 'evm:unknown'),
    ref('D2'),
    ref('TRON-1'),
  ];
  const published = new Set(['BTC-1', 'ETH-1', 'TRON-1', 'D2', 'CONTRACT-1'].map((s) => ref(s).address));

  // 1. Pre-screen (deny list, labels): excluded addresses need no chain data.
  const toFetch: AddressRef[] = [];
  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop
    const pre = await prescreenExclusions(candidate, exclusionDeps);
    if (effectiveOutcome(pre).outcome !== 'excluded') toFetch.push(candidate);
  }
  const tips = new TipCache();
  const fetched = await runChainFetch(
    toFetch.map((address) => ({ address })),
    registry,
    ctx,
    {
      enabledSources: CHAIN_SOURCES,
      tips,
    },
  );

  // 2. Address types, then exclusions with chain data (evm:unknown candidates resolved by the fetch).
  const resolvedOf = (c: AddressRef): AddressRef =>
    fetched.resolved.find((r) => addressKey(r.requested) === addressKey(c))?.resolved ??
    (c.chain.startsWith('evm:') ? { ...c, address: c.address.toLowerCase() } : c);
  const assets = createAssetRegistry();
  types = await classifyFetched(
    toFetch.map(resolvedOf),
    fetched,
    {
      providers: registry,
      labels,
      assets,
      safeSingletons: loadSafeSingletons(),
      entryPoints: loadEntryPoints(read('config/labels/erc4337-entrypoints.v1.yaml')),
    },
    ctx,
  );
  for (const candidate of candidates) {
    const resolved = resolvedOf(candidate);
    const classification = types.get(addressKey(resolved));
    decisions.push(
      // oxlint-disable-next-line no-await-in-loop
      ...(await evaluateExclusions(
        {
          address: candidate,
          // the explicit resolution of an evm:unknown candidate (transfers never cross chains otherwise)
          ...(candidate.chain === 'evm:unknown' ? { resolved } : {}),
          ...(classification ? { classification } : {}),
          transfers: transfersOf(resolved, fetched.transfers),
          published: published.has(candidate.address),
        },
        exclusionDeps,
      )),
    );
  }
  const kept = candidates.filter(
    (c) =>
      effectiveOutcome(decisions.filter((d) => d.address.address.toLowerCase() === c.address.toLowerCase())).outcome !==
      'excluded',
  );
  const analysed = kept.map(resolvedOf);
  const requestedOf = new Map(kept.map((c) => [addressKey(resolvedOf(c)), c]));

  // 3. One-hop expansion of unlabelled recipients (deposit addresses show themselves by their sweeps).
  const fetchedKeys = new Set(analysed.map(addressKey));
  const expansion: AddressRef[] = [];
  for (const a of analysed) {
    expansion.push(
      // oxlint-disable-next-line no-await-in-loop
      ...(await planCounterpartyExpansion(
        {
          address: a,
          transfers: transfersOf(a, fetched.transfers),
          utxoTxs: fetched.utxoTxs.filter((tx) => [...tx.inputs, ...tx.outputs].some((io) => io.address === a.address)),
        },
        { labels, assets },
        { fetched: fetchedKeys },
      )),
    );
  }
  const hop = await runChainFetch(
    expansion.map((address) => ({ address, want: { summary: false, code: false, utxo: false } })),
    registry,
    ctx,
    { enabledSources: CHAIN_SOURCES, tips },
  );
  const counterpartyTransfers = new Map(expansion.map((a) => [addressKey(a), transfersOf(a, hop.transfers)]));

  // 4. Activity, cash-out and flows (synthetic flat USD/PLN rate instead of live NBP).
  const fx: FxRateSource = {
    plnRate: async (currency) => ({ table: '000/A/NBP/2026', effectiveDate: '2026-01-01', currency, rate: '3.6500' }),
  };
  const deps = {
    labels,
    assets,
    valuator: createValuator({
      fx,
      prices: createSeriesPriceSource(loadPriceDataset(read('fixtures/prices/demo-prices.v1.json'))),
      assets,
    }),
    forwarding: rules.a4,
    rules: loadCashOutRules(read('config/rules/cashout.v1.yaml')),
    score: loadCashOutScoreConfig(read('config/rules/cashout-score.v1.yaml')),
    runId,
  };
  for (const a of analysed) {
    analyses.set(
      a.address,
      // oxlint-disable-next-line no-await-in-loop
      await analyseAddress(
        {
          address: a,
          ...(requestedOf.get(addressKey(a))?.chain === 'evm:unknown'
            ? { requested: requestedOf.get(addressKey(a)) }
            : {}),
          transfers: transfersOf(a, fetched.transfers),
          utxoTxs: fetched.utxoTxs.filter((tx) => [...tx.inputs, ...tx.outputs].some((io) => io.address === a.address)),
          decisions,
          counterpartyTransfers,
          analysed: new Set(analysed.map(addressKey)),
        },
        deps,
        ctx,
      ),
    );
  }
}, 30_000);

afterAll(() => site.close());

describe('chain analysis of the synthetic persona (v1)', () => {
  it('rejects exactly the expected misattributions', () => {
    const decisive = manifest.expected.v1.rejected.map((r) => {
      const address = ref(r.slot).address.toLowerCase();
      const outcome = effectiveOutcome(decisions.filter((d) => d.address.address.toLowerCase() === address));
      return { slot: r.slot, rule: outcome.decisive?.ruleId, relation: outcome.decisive?.relation };
    });
    expect(decisive).toEqual(
      manifest.expected.v1.rejected.map((r) => ({ slot: r.slot, rule: r.rule, relation: r.relation })),
    );
    expect(decisions.map((d) => d.ruleId).toSorted()).toEqual(['A1', 'A2', 'A4', 'A8']);
    const a4 = decisions.find((d) => d.ruleId === 'A4');
    expect(a4?.evidence).toMatchObject({
      kappa: 0.957013,
      kycLead: true,
      forwardsTo: { entity: 'Giełda Testowa (SYNTHETIC)' },
    });
  });

  it('records the expected cash-out indicators (exchange interactions are recorded, never attributed)', () => {
    const found = [...analyses.values()].flatMap((a) =>
      a.events.map((e) => ({
        rule: e.ruleId,
        slot: Object.keys(manifest.addresses).find(
          (s) => ref(s).address.toLowerCase() === e.address.address.toLowerCase(),
        ),
      })),
    );
    expect(found).toEqual(
      expect.arrayContaining(manifest.expected.v1.cashOut.map((c) => ({ rule: c.rule, slot: c.slot }))),
    );
    expect(found).toHaveLength(manifest.expected.v1.cashOut.length);
    const eth1 = analyses.get(ref('ETH-1').address.toLowerCase());
    expect(eth1?.events[0]).toMatchObject({ amount: '1.5', asset: 'ETH', strength: 'strong', hops: 0 });
    // the deposit quoted in the forum post (decoy D1 is its hash) and the sweep to HOT-1
    expect(eth1?.events[0]?.txHashes[0]).toBe(ref('TX-DECOY').address);
    expect(eth1?.events[0]?.txHashes).toHaveLength(2);
    expect(eth1?.indicators.cashOut.score).toBe(60);
    expect(analyses.get(ref('TRON-1').address)?.indicators.cashOut.score).toBe(72);
  });

  it('computes BTC-1 volumes from UTXO nets and never analyses excluded addresses', () => {
    const btc = analyses.get(ref('BTC-1').address)?.indicators;
    expect(btc).toMatchObject({
      txCount: 5,
      volumeIn: { native: '0.39' },
      volumeOut: { native: '0.35' },
      counterpartyCount: 4,
    });
    expect(analyses.has(ref('HOT-1').address.toLowerCase())).toBe(false);
    expect(analyses.has(ref('CONTRACT-1').address.toLowerCase())).toBe(false);
  });

  it('classifies the fetched addresses: CONTRACT-1 is a plain contract after negative probes, the accounts are EOAs', () => {
    const contract = typeOf('CONTRACT-1', 'evm:1');
    expect(contract).toMatchObject({ type: 'contract', codePrefix: '0x60806040' });
    expect(contract?.failedProbe).toBeUndefined();
    // code, Safe slot, entryPoint(), totalSupply(), ERC-1967 slot: in call order, each an identifying request
    const probes = (contract?.fetchIds ?? []).map((id) => envelopes.find((e) => e.fetchId === id));
    expect(probes.map((p) => new URL(p?.url ?? 'http://x').searchParams.get('action'))).toEqual([
      'eth_getCode',
      'eth_getStorageAt',
      'eth_call',
      'eth_call',
      'eth_getStorageAt',
    ]);
    const logged = probes.map((p) => log.find((e) => e.id === p?.egressLogId));
    expect(logged.every((e) => e?.allowed && e.containsIdentifier)).toBe(true);
    for (const slot of ['ETH-1', 'ETH-2', 'TRON-1']) {
      expect([slot, typeOf(slot)?.type, typeOf(slot)?.fetchIds.length]).toEqual([slot, 'eoa', 1]);
    }
    expect(typeOf('BTC-1')).toMatchObject({ type: 'utxo_script', scriptType: 'p2wpkh', fetchIds: [] });
    // Addresses excluded before any chain data (A1, A8) are not probed.
    expect(typeOf('HOT-1', 'evm:1')).toBeUndefined();
    expect(typeOf('D2')).toBeUndefined();
  });

  it('sends every request through the egress client, marked as synthetic and identifying when it carries an address', () => {
    expect(log.length).toBeGreaterThan(10);
    expect(log.every((e) => e.allowed && e.host === '127.0.0.1')).toBe(true);
    expect(log.filter((e) => !e.containsIdentifier).every((e) => TIP_PURPOSES.has(e.purpose))).toBe(true);
    expect(envelopes.every((p) => p.synthetic === true)).toBe(true);
  });
});
