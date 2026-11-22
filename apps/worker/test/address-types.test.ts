/**
 * The chain stage's address-type step: the classifier starts from the code the fetch read and probes through the
 * provider that served it; a code-read failure is recorded without new requests; addresses without data stay unknown.
 * A fake provider (no network) and synthetic addresses.
 */
import { createAssetRegistry } from '@olcys/analytics';
import { ChainProviderRegistry, type ChainFetchResult, type ChainProviderConfig } from '@olcys/chain-adapters';
import type { AddressRef, ChainCallResult, ChainProvider, RunContext } from '@olcys/core';
import { newId } from '@olcys/core';
import { loadSafeSingletons, MemoryLabelLookup } from '@olcys/labels';
import { describe, expect, it } from 'vitest';
import { classifyFetched } from '../src/address-types.ts';

const ctx: RunContext = {
  runId: newId(),
  caseId: newId(),
  mode: 'offline',
  http: { fetch: () => Promise.reject(new Error('no network in tests')) },
  blobs: {
    put: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    has: () => Promise.resolve(false),
  },
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

const SAFE_141 = '0x41675c099f32341bf84bfc5382af534df5c7461a';
const config: ChainProviderConfig = {
  id: 'fake',
  kind: 'etherscan',
  sourceId: 'etherscan_v2',
  baseUrl: 'https://x.test',
  chains: ['evm:1'],
  priority: 1,
};

function setup() {
  const requests: string[] = [];
  const provider: ChainProvider = {
    id: 'fake',
    chains: ['evm:1'],
    getTip: () => Promise.reject(new Error('not used')),
    getAddressSummary: () => Promise.reject(new Error('not used')),
    listTransfers: () => Promise.reject(new Error('not used')),
    getCode: () => Promise.reject(new Error('the stage passes the fetched code')),
    getStorageAt: (_a: AddressRef, slot: string) => {
      requests.push(`getStorageAt ${slot}`);
      return Promise.resolve({ value: `0x${'0'.repeat(24)}${SAFE_141.slice(2)}`, fetchId: 'f-slot' });
    },
    call: (): Promise<ChainCallResult> => Promise.reject(new Error('not reached for a Safe')),
  };
  const providers = new ChainProviderRegistry();
  providers.register(provider, config);
  const deps = {
    providers,
    labels: new MemoryLabelLookup([]),
    assets: createAssetRegistry(),
    safeSingletons: loadSafeSingletons(),
    entryPoints: new Set<string>(),
  };
  return { deps, requests };
}

const safe: AddressRef = { chain: 'evm:1', address: `0x${'5a'.repeat(20)}` };
const broken: AddressRef = { chain: 'evm:1', address: `0x${'6b'.repeat(20)}` };
const silent: AddressRef = { chain: 'evm:1', address: `0x${'7c'.repeat(20)}` };

describe('classifyFetched', () => {
  it('probes through the provider that served the code, records code failures and never re-fetches', async () => {
    const { deps, requests } = setup();
    const fetched: Pick<ChainFetchResult, 'codes' | 'outcomes'> = {
      codes: [{ address: safe, code: `0x6080604052${'ab'.repeat(40)}`, fetchId: 'f-code', providerId: 'fake' }],
      outcomes: [
        { address: safe, chain: 'evm:1', providerId: 'fake', status: 'ok', pages: 1, items: 0 },
        {
          address: { chain: 'evm:unknown', address: broken.address.toUpperCase().replace('0X', '0x') },
          chain: 'evm:1',
          providerId: 'fake',
          status: 'ok',
          pages: 1,
          items: 0,
          codeError: { kind: 'not_found', message: 'fake: not_found: HTTP 404', fetchId: 'f-404' },
        },
        { address: silent, chain: 'evm:1', providerId: 'fake', status: 'blocked', pages: 0, items: 0 },
      ],
    };
    const types = await classifyFetched([safe, broken, silent, safe], fetched, deps, ctx);
    expect([...types.keys()]).toEqual([`evm:1:${safe.address}`, `evm:1:${broken.address}`, `evm:1:${silent.address}`]);
    expect(types.get(`evm:1:${safe.address}`)).toMatchObject({
      type: 'safe',
      safeMasterCopy: SAFE_141,
      fetchIds: ['f-code', 'f-slot'],
    });
    expect(types.get(`evm:1:${broken.address}`)).toEqual({
      address: broken,
      type: 'unknown',
      failedProbe: { probe: 'code', message: 'fake: not_found: HTTP 404' },
      fetchIds: ['f-404'],
    });
    expect(types.get(`evm:1:${silent.address}`)).toEqual({ address: silent, type: 'unknown', fetchIds: [] });
    expect(requests).toEqual(['getStorageAt 0x0']);
  });
});
