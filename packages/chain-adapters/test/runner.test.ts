import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressSummary, ChainProvider, ChainTip, NormalizedTransfer } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ChainProviderError,
  ChainProviderRegistry,
  loadChainProviderConfig,
  runChainFetch,
  withFixtureSite,
  type ChainProviderConfig,
} from '../src/index.ts';
import { FakeEgressClient, REPO_ROOT, testContext } from './helpers/fake-egress.ts';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
const sources = parseYaml(read('config/sources.yaml')) as {
  providers: Record<string, { compliance: 'GREEN' | 'AMBER' | 'RED' }>;
};

const yaml = (sourceId: string): string =>
  `version: x\nproviders:\n  - { id: p, kind: esplora, sourceId: ${sourceId}, baseUrl: 'https://x.test', chains: [bitcoin] }\n`;

describe('chain provider config', () => {
  it('loads the repository config against the source register', () => {
    const configs = loadChainProviderConfig(read('config/chain-providers.yaml'), sources);
    expect(configs.map((c) => c.id)).toEqual([
      'esplora-mempool',
      'esplora-blockstream',
      'etherscan-v2',
      'trongrid',
      'solana-rpc',
      'evm-otterscan',
    ]);
  });

  it('refuses unregistered and RED sources', () => {
    expect(() => loadChainProviderConfig(yaml('nope'), sources)).toThrow(/not registered/);
    expect(() => loadChainProviderConfig(yaml('red_one'), { providers: { red_one: { compliance: 'RED' } } })).toThrow(
      /RED/,
    );
  });

  it('maps real base URLs to fixture paths with the manifest host prefixes', () => {
    const manifest = JSON.parse(read('fixtures/persona/manifest.json')) as { hostPrefixes: Record<string, string> };
    const mapped = withFixtureSite(
      loadChainProviderConfig(read('config/chain-providers.yaml')),
      'http://127.0.0.1:4100/',
      manifest.hostPrefixes,
    );
    expect(mapped.map((c) => c.baseUrl)).toEqual([
      'http://127.0.0.1:4100/chain/esplora/api',
      'http://127.0.0.1:4100/chain/esplora/api',
      'http://127.0.0.1:4100/chain/etherscan/v2/api',
      'http://127.0.0.1:4100/chain/trongrid',
      'http://127.0.0.1:4100/chain/solana-rpc',
      'http://127.0.0.1:8545', // the sandbox node is not a fixture-site path
    ]);
  });
});

const cfg = (id: string, sourceId: string, priority: number): ChainProviderConfig => ({
  id,
  kind: 'etherscan',
  sourceId,
  baseUrl: 'https://x.test',
  chains: ['evm:1', 'evm:137'],
  priority,
});
const transfer = (over: Partial<NormalizedTransfer>): NormalizedTransfer => ({
  chain: 'evm:1',
  txHash: '0x01',
  blockHeight: 100,
  blockTime: '2026-11-01T00:00:00.000Z',
  from: '0xaa',
  to: '0xbb',
  asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
  amount: '1',
  kind: 'native',
  fetchId: 'f',
  ...over,
});

function fakeProvider(
  id: string,
  behaviour: { fail?: ChainProviderError; endless?: boolean; chainsWithHistory?: string[]; tip?: ChainTip },
): ChainProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    chains: ['evm:1', 'evm:137'],
    calls,
    getTip: async () => behaviour.tip ?? { height: 1000, hash: '', observedAt: '2026-11-21T00:00:00.000Z' },
    getAddressSummary: async (address): Promise<AddressSummary> => {
      calls.push(`summary ${address.chain}`);
      if (behaviour.fail) throw behaviour.fail;
      return { address, txCount: 0, balance: '0', fetchId: 'f' };
    },
    listTransfers: async (address, options) => {
      calls.push(`list ${address.chain}`);
      const has = behaviour.chainsWithHistory?.includes(address.chain) ?? true;
      if (!has) return { items: [] };
      if (behaviour.endless)
        return { items: [transfer({ chain: address.chain, txHash: `0x${calls.length}` })], nextCursor: 'more' };
      return {
        items: [
          transfer({ chain: address.chain, from: address.address }),
          transfer({ chain: address.chain, from: address.address }),
          transfer({ chain: address.chain, txHash: '0x02', blockHeight: 2000 }),
        ],
        ...(options.cursor ? {} : {}),
      };
    },
    getCode: async (address) => ({ code: address.chain === 'evm:1' ? '0x' : '0x6080', fetchId: 'f' }),
  };
}

describe('runChainFetch', () => {
  const ctx = testContext(new FakeEgressClient(() => ({ body: {} })));

  it('falls back to the next provider when one is blocked and keeps both outcomes', async () => {
    const registry = new ChainProviderRegistry();
    const a = fakeProvider('a', { fail: new ChainProviderError('blocked', 'a', 'HTTP 403') });
    const b = fakeProvider('b', {});
    registry.register(a, cfg('a', 'src_a', 1));
    registry.register(b, cfg('b', 'src_b', 2));
    const result = await runChainFetch([{ address: { chain: 'evm:1', address: '0xAA' } }], registry, ctx, {
      enabledSources: ['src_a', 'src_b'],
    });
    expect(result.outcomes.map((o) => [o.providerId, o.status])).toEqual([
      ['a', 'blocked'],
      ['b', 'ok'],
    ]);
    // duplicate removed, the item above the tip (block 2000 > 1000) dropped, address lower-cased
    expect(result.transfers).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({ txCount: 1, firstSeen: '2026-11-01T00:00:00.000Z' });
    // the code is recorded with the provider that served it (the address-type probes use the same one)
    expect(result.codes).toEqual([
      { address: { chain: 'evm:1', address: '0xaa' }, code: '0x', fetchId: 'f', providerId: 'b' },
    ]);
    // a disabled source is never used
    expect(registry.forChain('evm:1', ['src_b'])).toEqual([b]);
  });

  it('stops an endless listing at the page limit as truncated', async () => {
    const registry = new ChainProviderRegistry();
    registry.register(fakeProvider('a', { endless: true }), cfg('a', 'src_a', 1));
    const result = await runChainFetch([{ address: { chain: 'evm:1', address: '0xaa' } }], registry, ctx, {
      enabledSources: ['src_a'],
      defaultMaxPages: 5,
    });
    expect(result.outcomes[0]).toMatchObject({ status: 'truncated', pages: 5 });
  });

  it('resolves evm:unknown on the configured EVM chains', async () => {
    const registry = new ChainProviderRegistry();
    registry.register(fakeProvider('a', { chainsWithHistory: ['evm:137'] }), cfg('a', 'src_a', 1));
    const result = await runChainFetch([{ address: { chain: 'evm:unknown', address: '0xaa' } }], registry, ctx, {
      enabledSources: ['src_a'],
      unknownEvmChains: ['evm:1', 'evm:137'],
    });
    expect(result.outcomes.map((o) => [o.chain, o.items])).toEqual([
      ['evm:1', 0],
      ['evm:137', 1],
    ]);
    expect(result.transfers.every((t) => t.chain === 'evm:137')).toBe(true);
    expect(result.resolved.map((r) => r.resolved.chain)).toEqual(['evm:1', 'evm:137']);
    expect(result.outcomes.every((o) => o.address.chain === 'evm:unknown')).toBe(true);
  });

  it('keeps the history when only the contract code cannot be read', async () => {
    const registry = new ChainProviderRegistry();
    const provider = fakeProvider('a', {});
    provider.getCode = () =>
      Promise.reject(new ChainProviderError('not_found', 'a', 'HTTP 404 from the node endpoint', { fetchId: 'f-404' }));
    registry.register(provider, cfg('a', 'src_a', 1));
    const result = await runChainFetch([{ address: { chain: 'evm:1', address: '0xaa' } }], registry, ctx, {
      enabledSources: ['src_a'],
    });
    expect(result.codes).toEqual([]);
    expect(result.transfers).toHaveLength(1);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        providerId: 'a',
        status: 'ok',
        codeError: { kind: 'not_found', message: 'a: not_found: HTTP 404 from the node endpoint', fetchId: 'f-404' },
      }),
    ]);
    // A bug in an adapter is not an expected failure.
    provider.getCode = () => Promise.reject(new TypeError('broken adapter'));
    await expect(
      runChainFetch([{ address: { chain: 'evm:1', address: '0xab' } }], registry, ctx, { enabledSources: ['src_a'] }),
    ).rejects.toThrow('broken adapter');
  });

  it('reports chains without an enabled provider as unsupported', async () => {
    const result = await runChainFetch(
      [{ address: { chain: 'solana', address: 'x' } }],
      new ChainProviderRegistry(),
      ctx,
      {
        enabledSources: [],
      },
    );
    expect(result.outcomes).toEqual([
      { address: { chain: 'solana', address: 'x' }, chain: 'solana', status: 'unsupported', pages: 0, items: 0 },
    ]);
  });
});
