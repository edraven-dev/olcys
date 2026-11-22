/**
 * The address-type decision procedure with a scripted provider (synthetic addresses): every probe's fetch id is
 * recorded in call order, reverted calls are negative probes, missing port methods skip their probes and expected
 * provider failures never throw.
 */
import type { AddressLabel, AddressRef } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  ERC1967_IMPLEMENTATION_SLOT,
  loadSafeSingletons,
  MemoryLabelLookup,
  SELECTORS,
  type ClassifierDeps,
} from '../src/index.ts';
import { ctx, providerError, scriptedProvider, word, type Script } from './helpers.ts';

const SAFE_141 = '0x41675c099f32341bf84bfc5382af534df5c7461a';
const SAFE_L2_141 = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762';
const ENTRY_POINT_07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const USDT_EVM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CONTRACT_CODE = `0x6080604052${'ab'.repeat(40)}`;

const ME: AddressRef = { chain: 'evm:1', address: `0x${'1a'.repeat(20)}` };
const safeSingletons = loadSafeSingletons();
const entryPoints = new Set([ENTRY_POINT_07]);
const registry = new Set([`evm:1|${USDT_EVM}`, `tron|${USDT_TRON}`]);

function deps(script: Script, extra: Partial<ClassifierDeps> = {}) {
  const provider = scriptedProvider(script);
  const all: ClassifierDeps = {
    provider,
    labels: new MemoryLabelLookup([]),
    assets: { isToken: (a) => registry.has(`${a.chain}|${a.address}`) },
    safeSingletons,
    entryPoints,
    ...extra,
  };
  return { deps: all, provider };
}

describe('EVM accounts', () => {
  it('AC1: code 0x is an EOA after exactly one request', async () => {
    const { deps: d, provider } = deps({});
    expect(await classifyAddress(ME, d, ctx)).toEqual({ address: ME, type: 'eoa', codeSize: 0, fetchIds: ['f1'] });
    expect(provider.requests).toEqual(['getCode']);
  });

  it('AC2: an EIP-7702 designator is a delegated EOA without storage or call probes', async () => {
    const { deps: d, provider } = deps({ code: { [ME.address]: `0xef0100${'ab'.repeat(20)}` } });
    expect(await classifyAddress(ME, d, ctx)).toEqual({
      address: ME,
      type: 'delegated_eoa',
      delegate: `0x${'ab'.repeat(20)}`,
      codePrefix: '0xef0100',
      codeSize: 23,
      fetchIds: ['f1'],
    });
    expect(provider.requests).toEqual(['getCode']);
  });

  it('AC2: a 0xef0100 code of another length is malformed: unknown, no probes', async () => {
    const { deps: d, provider } = deps({ code: { [ME.address]: `0xef0100${'ab'.repeat(21)}` } });
    expect(await classifyAddress(ME, d, ctx)).toEqual({
      address: ME,
      type: 'unknown',
      codePrefix: '0xef0100',
      codeSize: 24,
      fetchIds: ['f1'],
    });
    expect(provider.requests).toEqual(['getCode']);
  });

  it('uses code the chain fetch already read: no second request', async () => {
    const { deps: d, provider } = deps({}, { code: { code: '0x', fetchId: 'fetched' } });
    expect(await classifyAddress(ME, d, ctx)).toMatchObject({ type: 'eoa', fetchIds: ['fetched'] });
    expect(provider.requests).toEqual([]);
  });
});

describe('smart accounts', () => {
  it('AC3: slot 0 holding the v1.4.1 singleton (or its L2 variant) on evm:1 is a Safe', async () => {
    for (const singleton of [SAFE_141, SAFE_L2_141]) {
      const { deps: d, provider } = deps({
        code: { [ME.address]: CONTRACT_CODE },
        storage: { [`${ME.address}|0x0`]: word(singleton) },
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await classifyAddress(ME, d, ctx)).toEqual({
        address: ME,
        type: 'safe',
        safeMasterCopy: singleton,
        codePrefix: '0x60806040',
        codeSize: (CONTRACT_CODE.length - 2) / 2,
        fetchIds: ['f1', 'f2'],
      });
      expect(provider.requests).toEqual(['getCode', 'getStorageAt 0x0']);
    }
  });

  it('AC3: a random slot-0 value, or a singleton of another network, is not a Safe', async () => {
    const random = deps({
      code: { [ME.address]: CONTRACT_CODE },
      storage: { [`${ME.address}|0x0`]: word('7f'.repeat(20)) },
    });
    expect((await classifyAddress(ME, random.deps, ctx)).type).toBe('contract');
    // The singleton address with non-zero high bytes is a different value, not an address.
    const packed = deps({
      code: { [ME.address]: CONTRACT_CODE },
      storage: { [`${ME.address}|0x0`]: `0x${'01'.repeat(12)}${SAFE_141.slice(2)}` },
    });
    expect((await classifyAddress(ME, packed.deps, ctx)).type).toBe('contract');
    const elsewhere = deps(
      { code: { [ME.address]: CONTRACT_CODE }, storage: { [`${ME.address}|0x0`]: word(SAFE_141) } },
      { safeSingletons: new Map([['evm:137', new Set([SAFE_141])]]) },
    );
    expect((await classifyAddress(ME, elsewhere.deps, ctx)).type).toBe('contract');
  });

  it('AC4: entryPoint() returning the v0.7 EntryPoint is an ERC-4337 account', async () => {
    const { deps: d, provider } = deps({
      code: { [ME.address]: CONTRACT_CODE },
      calls: { [`${ME.address}|${SELECTORS.entryPoint}`]: word(ENTRY_POINT_07) },
    });
    expect(await classifyAddress(ME, d, ctx)).toMatchObject({
      type: 'erc4337_account',
      entryPoint: ENTRY_POINT_07,
      fetchIds: ['f1', 'f2', 'f3'],
    });
    expect(provider.requests).toEqual(['getCode', 'getStorageAt 0x0', `call ${SELECTORS.entryPoint}`]);
  });

  it('AC4: an unknown EntryPoint or a revert is a negative probe', async () => {
    const unknown = deps({
      code: { [ME.address]: CONTRACT_CODE },
      calls: { [`${ME.address}|${SELECTORS.entryPoint}`]: word('e1'.repeat(20)) },
    });
    expect((await classifyAddress(ME, unknown.deps, ctx)).type).toBe('contract');
    const reverted = deps({ code: { [ME.address]: CONTRACT_CODE } });
    const result = await classifyAddress(ME, reverted.deps, ctx);
    expect(result.type).toBe('contract');
    expect(result.failedProbe).toBeUndefined();
  });
});

describe('contracts', () => {
  it('AC5: totalSupply() and decimals() = 6 make a token contract', async () => {
    const { deps: d, provider } = deps({
      code: { [ME.address]: CONTRACT_CODE },
      calls: {
        [`${ME.address}|${SELECTORS.totalSupply}`]: word(1_000_000),
        [`${ME.address}|${SELECTORS.decimals}`]: word(6),
      },
    });
    expect(await classifyAddress(ME, d, ctx)).toMatchObject({
      type: 'token_contract',
      fetchIds: ['f1', 'f2', 'f3', 'f4', 'f5'],
    });
    expect(provider.requests).toEqual([
      'getCode',
      'getStorageAt 0x0',
      `call ${SELECTORS.entryPoint}`,
      `call ${SELECTORS.totalSupply}`,
      `call ${SELECTORS.decimals}`,
    ]);
  });

  it('AC5: decimals() above 255 or a missing decimals() is no token', async () => {
    const big = deps({
      code: { [ME.address]: CONTRACT_CODE },
      calls: {
        [`${ME.address}|${SELECTORS.totalSupply}`]: word(1),
        [`${ME.address}|${SELECTORS.decimals}`]: word(256),
      },
    });
    expect((await classifyAddress(ME, big.deps, ctx)).type).toBe('contract');
    const nft = deps({
      code: { [ME.address]: CONTRACT_CODE },
      calls: { [`${ME.address}|${SELECTORS.totalSupply}`]: word(10) },
    });
    expect((await classifyAddress(ME, nft.deps, ctx)).type).toBe('contract');
  });

  it('AC5: the registry USDT contract and a token label need no call probes', async () => {
    const usdt: AddressRef = { chain: 'evm:1', address: USDT_EVM };
    const registered = deps({ code: { [USDT_EVM]: CONTRACT_CODE } });
    expect(await classifyAddress(usdt, registered.deps, ctx)).toMatchObject({
      type: 'token_contract',
      fetchIds: ['f1'],
    });
    expect(registered.provider.requests).toEqual(['getCode']);

    const label = {
      id: 'l1',
      address: ME,
      entity: 'Token Testowy (SYNTHETIC)',
      category: 'token_contract',
      attributes: {},
      confidence: 90,
      provenance: { datasetId: 'demo', url: 'x', license: 'CC0-1.0', lastmod: '2026-01-01T00:00:00Z', retrievedAt: '' },
    } satisfies AddressLabel;
    const labelled = deps({ code: { [ME.address]: CONTRACT_CODE } }, { labels: new MemoryLabelLookup([label]) });
    expect((await classifyAddress(ME, labelled.deps, ctx)).type).toBe('token_contract');
    expect(labelled.provider.requests).toEqual(['getCode']);
  });

  it('AC5: a contract with no match is a contract, with its ERC-1967 implementation when set', async () => {
    const plain = deps({ code: { [ME.address]: CONTRACT_CODE } });
    expect(await classifyAddress(ME, plain.deps, ctx)).toEqual({
      address: ME,
      type: 'contract',
      codePrefix: '0x60806040',
      codeSize: (CONTRACT_CODE.length - 2) / 2,
      fetchIds: ['f1', 'f2', 'f3', 'f4', 'f5'],
    });
    expect(plain.provider.requests).toEqual([
      'getCode',
      'getStorageAt 0x0',
      `call ${SELECTORS.entryPoint}`,
      `call ${SELECTORS.totalSupply}`,
      `getStorageAt ${ERC1967_IMPLEMENTATION_SLOT}`,
    ]);
    const implementation = `0x${'1e'.repeat(20)}`;
    const proxy = deps({
      code: { [ME.address]: CONTRACT_CODE },
      storage: { [`${ME.address}|${ERC1967_IMPLEMENTATION_SLOT}`]: word(implementation) },
    });
    expect(await classifyAddress(ME, proxy.deps, ctx)).toMatchObject({ type: 'contract', implementation });
  });

  it('skips the probes a provider does not offer', async () => {
    const noCall = deps({ code: { [ME.address]: CONTRACT_CODE }, without: ['call'] });
    expect(await classifyAddress(ME, noCall.deps, ctx)).toMatchObject({
      type: 'contract',
      fetchIds: ['f1', 'f2', 'f3'],
    });
    expect(noCall.provider.requests).toEqual([
      'getCode',
      'getStorageAt 0x0',
      `getStorageAt ${ERC1967_IMPLEMENTATION_SLOT}`,
    ]);
    const codeOnly = deps({ code: { [ME.address]: CONTRACT_CODE }, without: ['call', 'getStorageAt'] });
    expect(await classifyAddress(ME, codeOnly.deps, ctx)).toMatchObject({ type: 'contract', fetchIds: ['f1'] });
    // No provider at all: only what is known locally.
    const offline = deps({}, { provider: undefined });
    expect(await classifyAddress(ME, offline.deps, ctx)).toEqual({ address: ME, type: 'unknown', fetchIds: [] });
  });
});

describe('expected provider failures', () => {
  it('a failed code read leaves the type unknown and records the failure', async () => {
    const { deps: d } = deps({ failures: { getCode: providerError('etherscan-v2: rate_limited: HTTP 429', 'f-429') } });
    expect(await classifyAddress(ME, d, ctx)).toEqual({
      address: ME,
      type: 'unknown',
      failedProbe: { probe: 'code', message: 'etherscan-v2: rate_limited: HTTP 429' },
      fetchIds: ['f-429'],
    });
  });

  it('a failed Safe or EntryPoint probe cannot rule out a personal account: unknown, no more requests', async () => {
    const safe = deps({
      code: { [ME.address]: CONTRACT_CODE },
      failures: { 'getStorageAt 0x0': providerError('etherscan-v2: blocked: HTTP 403') },
    });
    expect(await classifyAddress(ME, safe.deps, ctx)).toMatchObject({
      type: 'unknown',
      codePrefix: '0x60806040',
      failedProbe: { probe: 'safe' },
      fetchIds: ['f1'],
    });
    expect(safe.provider.requests).toEqual(['getCode', 'getStorageAt 0x0']);
    const entry = deps({
      code: { [ME.address]: CONTRACT_CODE },
      failures: { [`call ${SELECTORS.entryPoint}`]: providerError('etherscan-v2: upstream_error: bad gateway') },
    });
    expect(await classifyAddress(ME, entry.deps, ctx)).toMatchObject({
      type: 'unknown',
      failedProbe: { probe: 'erc4337' },
    });
  });

  it('a failed token probe still leaves a contract (no personal account), without the implementation lookup', async () => {
    const { deps: d, provider } = deps({
      code: { [ME.address]: CONTRACT_CODE },
      failures: { [`call ${SELECTORS.totalSupply}`]: providerError('etherscan-v2: rate_limited: limit') },
    });
    expect(await classifyAddress(ME, d, ctx)).toMatchObject({ type: 'contract', failedProbe: { probe: 'token' } });
    expect(provider.requests).toHaveLength(4);
  });

  it('bugs are not swallowed', async () => {
    const { deps: d } = deps({ failures: { getCode: new TypeError('broken adapter') } });
    await expect(classifyAddress(ME, d, ctx)).rejects.toThrow('broken adapter');
  });
});

describe('TRON and other chains', () => {
  it('AC7: TRON bytecode of the registry USDT contract is a token contract; 0x is an account', async () => {
    const usdt: AddressRef = { chain: 'tron', address: USDT_TRON };
    const tron = deps({ code: { [USDT_TRON]: CONTRACT_CODE } });
    expect(await classifyAddress(usdt, tron.deps, ctx)).toMatchObject({
      type: 'token_contract',
      codePrefix: '0x60806040',
      fetchIds: ['f1'],
    });
    expect(tron.provider.requests).toEqual(['getCode']);
    const account: AddressRef = { chain: 'tron', address: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu' };
    expect(await classifyAddress(account, deps({}).deps, ctx)).toMatchObject({ type: 'eoa', codeSize: 0 });
    // Any other TRON contract: no storage or call probes on TRON.
    const other = deps({ code: { [account.address]: CONTRACT_CODE } });
    expect((await classifyAddress(account, other.deps, ctx)).type).toBe('contract');
    expect(other.provider.requests).toEqual(['getCode']);
  });

  it('chains without a classifier are unknown, without requests', async () => {
    const { deps: d, provider } = deps({});
    const solana: AddressRef = { chain: 'solana', address: '11111111111111111111111111111111' };
    expect(await classifyAddress(solana, d, ctx)).toEqual({ address: solana, type: 'unknown', fetchIds: [] });
    expect(provider.requests).toEqual([]);
  });
});
