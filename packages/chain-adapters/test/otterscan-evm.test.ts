import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainProvider, NormalizedTransfer } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ChainProviderError,
  ChainProviderRegistry,
  classifyOtterscan,
  createChainProviderRegistry,
  createOtterscanEvmProvider,
  decodeAbiString,
  loadChainProviderConfig,
  runChainFetch,
} from '../src/index.ts';
import { FakeEgressClient, REPO_ROOT, testContext } from './helpers/fake-egress.ts';
import {
  bodyText,
  fakeOtterscanNode,
  hash,
  methodsOf,
  word,
  type FakeNodeState,
} from './helpers/fake-otterscan-node.ts';

// Synthetic storyline (sandbox S1-S2 style): ETH-1 receives a deposit from EXCH, then sweeps it to HOT-1.
const ETH1 = '0x00000000000000000000000000000000000000a1';
const EXCH = '0x00000000000000000000000000000000000000b2';
const HOT1 = '0x00000000000000000000000000000000000000c3';
const TOKEN = '0x00000000000000000000000000000000000000d4';
const SPLITTER = '0x00000000000000000000000000000000000000e5';
const ETH = 10n ** 18n;
const RPC = 'http://127.0.0.1:8545';

const withoutFetchId = (t: NormalizedTransfer): NormalizedTransfer => Object.assign({}, t, { fetchId: '' });
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
const rowKey = (t: NormalizedTransfer): string => `${t.txHash}|${t.amount}`;

const DEPOSIT = hash(0xd1);
const SWEEP = hash(0xd2);
const TOKEN_IN = hash(0xd3);
const SPLIT = hash(0xd4);

function state(over: Partial<FakeNodeState> = {}): FakeNodeState {
  return {
    apiLevel: 8,
    tip: 110,
    txs: [
      { hash: DEPOSIT, block: 100, from: EXCH, to: ETH1, wei: (3n * ETH) / 2n },
      { hash: SWEEP, block: 105, from: ETH1, to: HOT1, wei: (1499n * ETH) / 1000n },
      {
        hash: SPLIT,
        block: 108,
        from: EXCH,
        to: SPLITTER,
        wei: 0n,
        input: '0xa9059cbb' + '00'.repeat(64),
        internal: [
          { from: SPLITTER, to: ETH1, wei: ETH / 4n },
          { from: SPLITTER, to: HOT1, wei: ETH / 8n }, // not ours: dropped
        ],
      },
      { hash: hash(0xd5), block: 109, from: ETH1, to: HOT1, wei: ETH, status: 0 }, // reverted: value did not move
    ],
    logs: [{ contract: TOKEN, from: EXCH, to: ETH1, amount: 250_000_000n, block: 107, tx: TOKEN_IN, logIndex: 3 }],
    tokens: { [TOKEN]: { symbol: 'TUSD', decimals: 6 } },
    code: { [TOKEN]: '0x6080604052', [ETH1]: '0x' },
    balances: { [ETH1]: ETH / 1000n },
    nonces: { [ETH1]: 2 },
    ...over,
  };
}

function setup(over: Partial<FakeNodeState> = {}, pageSize = 25, logBlockRange?: number) {
  const http = new FakeEgressClient(fakeOtterscanNode(state(over)));
  const provider = createOtterscanEvmProvider({
    chains: ['evm:1'],
    rpcUrl: RPC,
    sourceId: 'sandbox_anvil',
    pageSize,
    ...(logBlockRange ? { logBlockRange } : {}),
  });
  return { http, provider, ctx: testContext(http) };
}

async function listAll(provider: ChainProvider, ctx: ReturnType<typeof testContext>, toBlock?: number) {
  const items: NormalizedTransfer[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // Pages depend on the previous cursor.
    // oxlint-disable-next-line no-await-in-loop
    const page = await provider.listTransfers(
      { chain: 'evm:1', address: ETH1 },
      { ...(cursor ? { cursor } : {}), ...(toBlock !== undefined ? { toBlock } : {}) },
      ctx,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  return { items, pages };
}

describe('Otterscan provider: history', () => {
  it('AC1: lists the deposit and the sweep with amounts, blocks, timestamps and directions', async () => {
    const { provider, ctx } = setup();
    const { items } = await listAll(provider, ctx, 110);
    const native = items.filter((t) => t.kind === 'native').toSorted((a, b) => a.blockHeight - b.blockHeight);
    expect(native).toHaveLength(2);
    expect(native[0]).toMatchObject({
      txHash: DEPOSIT,
      blockHeight: 100,
      from: EXCH,
      to: ETH1,
      amount: '1.5',
      blockTime: new Date((1_800_000_000 + 100 * 12) * 1000).toISOString(),
      asset: { symbol: 'ETH', decimals: 18 },
    });
    expect(native[1]).toMatchObject({ txHash: SWEEP, blockHeight: 105, from: ETH1, to: HOT1, amount: '1.499' });
  });

  it('maps internal transfers of the address only, reverted transactions not at all', async () => {
    const { provider, ctx } = setup();
    const { items } = await listAll(provider, ctx, 110);
    const internal = items.filter((t) => t.kind === 'internal');
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ txHash: SPLIT, from: SPLITTER, to: ETH1, amount: '0.25', index: 0 });
    expect(items.some((t) => t.txHash === hash(0xd5))).toBe(false);
  });

  it('does not emit the top-level call again when the node lists it as an internal operation', async () => {
    const call = {
      hash: hash(0xd6),
      block: 106,
      from: ETH1,
      to: SPLITTER,
      wei: ETH,
      input: '0xabcdef12',
      internal: [{ from: SPLITTER, to: ETH1, wei: ETH / 10n }],
    };
    for (const includeTopLevelCall of [false, true]) {
      const { provider, ctx } = setup({ txs: [call], logs: [], includeTopLevelCall });
      // oxlint-disable-next-line no-await-in-loop
      const { items } = await listAll(provider, ctx, 110);
      expect(items.map((t) => [t.kind, t.amount])).toEqual([
        ['native', '1'],
        ['internal', '0.1'],
      ]);
    }
  });

  it('reads internal operations of an empty-input call to a contract that forwards value to the address', async () => {
    const forward = {
      hash: hash(0xd7),
      block: 106,
      from: EXCH,
      to: SPLITTER,
      wei: ETH,
      internal: [{ from: SPLITTER, to: ETH1, wei: ETH / 2n }],
    };
    const { provider, ctx, http } = setup({ txs: [forward], logs: [], code: { [SPLITTER]: '0x6080' } });
    const { items } = await listAll(provider, ctx, 110);
    expect(items.map((t) => [t.kind, t.from, t.to, t.amount])).toEqual([['internal', SPLITTER, ETH1, '0.5']]);
    expect(methodsOf(http.requests)).toContain('ots_getInternalOperations');
    // touched only internally: the top-level parties are other accounts, so the trace is read without a code lookup
    const plain = setup({ txs: [{ ...forward, hash: hash(0xd8) }], logs: [], code: {} });
    expect((await listAll(plain.provider, plain.ctx, 110)).items).toHaveLength(1);
  });

  it('does not trace a plain transfer to an account without code', async () => {
    const { provider, ctx, http } = setup({
      logs: [],
      txs: [{ hash: DEPOSIT, block: 100, from: EXCH, to: ETH1, wei: ETH }],
    });
    await listAll(provider, ctx, 110);
    const methods = methodsOf(http.requests);
    expect(methods).toContain('eth_getCode');
    expect(methods).not.toContain('ots_getInternalOperations');
  });

  it('AC2: an ERC-20 transfer is a token with symbol and decimals read from the contract', async () => {
    const { provider, ctx, http } = setup();
    const { items } = await listAll(provider, ctx, 110);
    const token = items.filter((t) => t.kind === 'token');
    expect(token).toEqual([
      expect.objectContaining({
        txHash: TOKEN_IN,
        index: 3,
        from: EXCH,
        to: ETH1,
        amount: '250',
        blockHeight: 107,
        asset: { chain: 'evm:1', symbol: 'TUSD', decimals: 6, contract: TOKEN },
      }),
    ]);
    // metadata is read once per contract and run
    expect(methodsOf(http.requests).filter((m) => m === 'eth_call')).toHaveLength(2);
  });

  it('chunks eth_getLogs by block range, newest first', async () => {
    const { provider, ctx, http } = setup({}, 25, 50);
    const { items } = await listAll(provider, ctx, 110);
    expect(items.filter((t) => t.kind === 'token')).toHaveLength(1);
    const ranges = http.requests
      .filter((r) => bodyText(r).includes('"eth_getLogs"'))
      .map((r) => {
        const f = (JSON.parse(bodyText(r)) as { params: { fromBlock: string; toBlock: string }[] }).params[0];
        return [Number.parseInt(f?.fromBlock ?? '', 16), Number.parseInt(f?.toBlock ?? '', 16)];
      });
    // tokenOut: 61..110, 11..60, 0..10; tokenIn: the same
    expect(ranges.slice(0, 3)).toEqual([
      [61, 110],
      [11, 60],
      [0, 10],
    ]);
    expect(ranges).toHaveLength(6);
  });

  it('skips tokens with unreadable decimals and drops zero-value spam', async () => {
    const BROKEN = '0x00000000000000000000000000000000000000f6';
    const { provider, ctx } = setup({
      logs: [
        { contract: BROKEN, from: EXCH, to: ETH1, amount: 5n, block: 101, tx: hash(0xe1), logIndex: 0 },
        { contract: TOKEN, from: EXCH, to: ETH1, amount: 0n, block: 102, tx: hash(0xe2), logIndex: 0 },
      ],
    });
    const page = await (async () => {
      let cursor: string | undefined;
      const skipped: unknown[] = [];
      const items: NormalizedTransfer[] = [];
      do {
        // oxlint-disable-next-line no-await-in-loop
        const p = await provider.listTransfers(
          { chain: 'evm:1', address: ETH1 },
          { ...(cursor ? { cursor } : {}), toBlock: 110 },
          ctx,
        );
        items.push(...p.items);
        skipped.push(...(p.skipped ?? []));
        cursor = p.nextCursor;
      } while (cursor);
      return { items, skipped };
    })();
    expect(page.items.some((t) => t.kind === 'token')).toBe(false);
    expect(page.skipped).toEqual([{ txHash: hash(0xe1), reason: 'unsupported_decimals' }]);
  });

  it('AC4: with pageSize 2 and 5 transactions three pages are fetched and the union equals one large page', async () => {
    const many: Partial<FakeNodeState> = {
      txs: [1, 2, 3, 4, 5].map((n) => ({
        hash: hash(0x500 + n),
        block: 10 * n,
        from: EXCH,
        to: ETH1,
        wei: BigInt(n) * ETH,
      })),
      logs: [],
    };
    const small = setup(many, 2);
    const large = setup(many, 100);
    const a = await listAll(small.provider, small.ctx, 110);
    const b = await listAll(large.provider, large.ctx, 110);
    expect(small.http.requests.filter((r) => bodyText(r).includes('"ots_searchTransactionsBefore"'))).toHaveLength(3);
    expect(large.http.requests.filter((r) => bodyText(r).includes('"ots_searchTransactionsBefore"'))).toHaveLength(1);
    expect(a.items.map(rowKey).toSorted()).toEqual(b.items.map(rowKey).toSorted());
    expect(a.items).toHaveLength(5);
  });

  it('pins the first page at the tip: transactions above it are not part of the snapshot', async () => {
    const { provider, ctx } = setup();
    const { items } = await listAll(provider, ctx, 104);
    expect(items.map((t) => t.txHash)).toEqual([DEPOSIT]);
  });

  it('reads the tip itself when the caller did not pin one', async () => {
    const { provider, ctx, http } = setup();
    const { items } = await listAll(provider, ctx);
    expect(items).toHaveLength(4);
    expect(methodsOf(http.requests).filter((m) => m === 'eth_blockNumber')).toHaveLength(1);
  });

  it('stops with a gap report when the node does not move below the cursor', async () => {
    const stuck = new FakeEgressClient((r) => {
      const { id, method } = JSON.parse(bodyText(r)) as { id: number; method: string };
      if (method === 'ots_getApiLevel') return { body: { jsonrpc: '2.0', id, result: 8 } };
      if (method === 'eth_getCode') return { body: { jsonrpc: '2.0', id, result: '0x' } };
      if (method === 'eth_chainId') return { body: { jsonrpc: '2.0', id, result: '0x1' } };
      return {
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            txs: [{ hash: DEPOSIT, blockNumber: '0x64', from: EXCH, to: ETH1, value: '0x1', input: '0x' }],
            receipts: [{ transactionHash: DEPOSIT, status: '0x1', timestamp: '0x6b49d200' }],
            lastPage: false,
          },
        },
      };
    });
    const provider = createOtterscanEvmProvider({ chains: ['evm:1'], rpcUrl: RPC, sourceId: 'sandbox_anvil' });
    const page = await provider.listTransfers({ chain: 'evm:1', address: ETH1 }, { toBlock: 99 }, testContext(stuck));
    expect(page.truncated).toBe(true);
  });
});

describe('Otterscan provider: state reads', () => {
  it('AC3: getCode is 0x for an EOA and bytecode for the token contract', async () => {
    const { provider, ctx } = setup();
    expect((await provider.getCode!({ chain: 'evm:1', address: ETH1 }, ctx)).code).toBe('0x');
    expect((await provider.getCode!({ chain: 'evm:1', address: TOKEN }, ctx)).code).toBe('0x6080604052');
  });

  it('summarises balance and sent-transaction count as DecimalStrings', async () => {
    const { provider, ctx } = setup();
    expect(await provider.getAddressSummary({ chain: 'evm:1', address: ETH1 }, ctx)).toMatchObject({
      balance: '0.001',
      txCount: 2,
    });
  });

  it('records the tip with block hash; storage reads and calls answer, a revert is an answer', async () => {
    const { provider, ctx } = setup();
    expect(await provider.getTip('evm:1', ctx)).toMatchObject({ height: 110, hash: hash(0xb10c0000 + 110) });
    expect((await provider.getStorageAt!({ chain: 'evm:1', address: TOKEN }, '0x0', ctx)).value).toBe(
      `0x${'0'.repeat(64)}`,
    );
    expect(await provider.call!({ chain: 'evm:1', address: TOKEN }, '0x313ce567', ctx)).toMatchObject({ status: 'ok' });
    expect(await provider.call!({ chain: 'evm:1', address: ETH1 }, '0x313ce567', ctx)).toMatchObject({
      status: 'reverted',
    });
  });

  it('refuses chains it is not configured for', async () => {
    const { provider, ctx, http } = setup();
    await expect(provider.getTip('evm:137', ctx)).rejects.toMatchObject({ kind: 'unsupported_chain' });
    expect(http.requests).toHaveLength(0);
  });
});

describe('Otterscan provider: availability', () => {
  it('AC5: API level below 8 is provider_unavailable and nothing else is requested', async () => {
    const { provider, ctx, http } = setup({ apiLevel: 7 });
    await expect(provider.getTip('evm:1', ctx)).rejects.toMatchObject({ kind: 'provider_unavailable' });
    await expect(listAll(provider, ctx, 110)).rejects.toMatchObject({ kind: 'provider_unavailable' });
    await expect(provider.getCode!({ chain: 'evm:1', address: ETH1 }, ctx)).rejects.toBeInstanceOf(ChainProviderError);
    expect(methodsOf(http.requests)).toEqual(['ots_getApiLevel']);
  });

  it('a node without the ots namespace is provider_unavailable too', async () => {
    const { provider, ctx, http } = setup({ apiLevel: 'missing' });
    await expect(provider.getTip('evm:1', ctx)).rejects.toMatchObject({ kind: 'provider_unavailable' });
    expect(http.requests).toHaveLength(1);
  });

  it('checks the API level once per run', async () => {
    const { provider, ctx, http } = setup();
    await provider.getTip('evm:1', ctx);
    await provider.getCode!({ chain: 'evm:1', address: ETH1 }, ctx);
    expect(methodsOf(http.requests).filter((m) => m === 'ots_getApiLevel')).toHaveLength(1);
  });

  it('a node on another chain id is provider_unavailable and no history is read', async () => {
    const { provider, ctx, http } = setup({ chainId: 137 });
    await expect(listAll(provider, ctx, 110)).rejects.toMatchObject({
      kind: 'provider_unavailable',
      message: expect.stringContaining('chain id 137'),
    });
    await expect(provider.getTip('evm:1', ctx)).rejects.toMatchObject({ kind: 'provider_unavailable' });
    expect(methodsOf(http.requests)).toEqual(['ots_getApiLevel', 'eth_chainId']);
  });

  it('checks the chain id once per run', async () => {
    const { provider, ctx, http } = setup();
    await provider.getTip('evm:1', ctx);
    await provider.getCode!({ chain: 'evm:1', address: ETH1 }, ctx);
    expect(methodsOf(http.requests).filter((m) => m === 'eth_chainId')).toHaveLength(1);
  });

  it('falls through to the next provider in the fetch runner', async () => {
    const down = setup({ apiLevel: 7 });
    const registry = new ChainProviderRegistry();
    registry.register(down.provider, {
      id: 'evm-otterscan',
      kind: 'otterscan',
      sourceId: 'sandbox_anvil',
      baseUrl: RPC,
      chains: ['evm:1'],
      priority: 0,
    });
    const result = await runChainFetch([{ address: { chain: 'evm:1', address: ETH1 } }], registry, down.ctx, {
      enabledSources: ['sandbox_anvil'],
    });
    expect(result.outcomes[0]).toMatchObject({ providerId: 'evm-otterscan', status: 'error' });
    expect(result.outcomes[0]?.error?.kind).toBe('provider_unavailable');
  });
});

async function run() {
  const { provider, ctx, http } = setup();
  await provider.getTip('evm:1', ctx);
  const out = await listAll(provider, ctx, 110);
  return { http, out };
}

describe('Otterscan provider: requests', () => {
  it('AC6: every request is a deterministic JSON-RPC POST with the identifier flag; replays are byte-identical', async () => {
    const first = await run();
    const second = await run();
    expect(first.http.requests.map((r) => bodyText(r))).toEqual(second.http.requests.map((r) => bodyText(r)));
    expect(JSON.stringify(first.out.items.map(withoutFetchId))).toBe(
      JSON.stringify(second.out.items.map(withoutFetchId)),
    );
    for (const r of first.http.requests) {
      expect(r.method).toBe('POST');
      expect(r.url).toBe(RPC);
      expect(r.sourceId).toBe('sandbox_anvil');
      expect(bodyText(r)).toMatch(/^\{"jsonrpc":"2\.0","id":\d+,"method":"[a-z_A-Z]+","params":/);
    }
    const flagged = new Map(
      first.http.requests.map((r) => [(JSON.parse(bodyText(r)) as { method: string }).method, r.containsIdentifier]),
    );
    expect(flagged.get('ots_searchTransactionsBefore')).toBe(true);
    expect(flagged.get('eth_blockNumber')).toBe(false);
    expect(flagged.get('ots_getApiLevel')).toBe(false);
    // one fixed id per method
    const ids = new Map<string, Set<number>>();
    for (const r of first.http.requests) {
      const { id, method } = JSON.parse(bodyText(r)) as { id: number; method: string };
      ids.set(method, (ids.get(method) ?? new Set()).add(id));
    }
    expect([...ids.values()].every((s) => s.size === 1)).toBe(true);
    // the tip with block hash is part of the provenance trail of the run
    expect(methodsOf(first.http.requests).slice(0, 4)).toEqual([
      'ots_getApiLevel',
      'eth_chainId',
      'eth_blockNumber',
      'eth_getBlockByNumber',
    ]);
  });
});

describe('Otterscan helpers and configuration', () => {
  it('classifies JSON-RPC bodies', () => {
    expect(classifyOtterscan({ jsonrpc: '2.0', id: 1, result: 8 })).toBe('ok');
    expect(classifyOtterscan({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } })).toBe('ok');
    expect(classifyOtterscan({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } })).toBe(
      'provider_unavailable',
    );
    expect(
      classifyOtterscan({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'query returned more than 10000 results' },
      }),
    ).toBe('window_exceeded');
    expect(classifyOtterscan({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })).toBe(
      'upstream_error',
    );
    expect(classifyOtterscan('<html>')).toBe('invalid_response');
  });

  it('decodes ABI strings and legacy bytes32 symbols, stripping control characters', () => {
    const dynamic = `0x${word(32n).slice(2)}${word(4n).slice(2)}${Buffer.from('TUSD').toString('hex').padEnd(64, '0')}`;
    expect(decodeAbiString(dynamic)).toBe('TUSD');
    expect(decodeAbiString(`0x${Buffer.from('MKR\u0000').toString('hex').padEnd(64, '0')}`)).toBe('MKR');
    expect(decodeAbiString('0x')).toBeUndefined();
  });

  it('is registered for sandbox_anvil, below Etherscan in no case: only when the case enables the source', () => {
    const sources = parseYaml(read('config/sources.yaml')) as {
      providers: Record<string, { compliance: 'GREEN' | 'AMBER' | 'RED'; enabledByDefault: boolean }>;
    };
    const configs = loadChainProviderConfig(read('config/chain-providers.yaml'), sources);
    const config = configs.find((c) => c.id === 'evm-otterscan');
    expect(config).toMatchObject({
      kind: 'otterscan',
      sourceId: 'sandbox_anvil',
      chains: ['evm:1'],
      baseUrlEnv: 'SANDBOX_EVM_RPC_URL',
    });
    expect(sources.providers['sandbox_anvil']?.enabledByDefault).toBe(false);
    const registry = createChainProviderRegistry(configs, { env: { SANDBOX_EVM_RPC_URL: 'http://anvil:8545' } });
    expect(registry.forChain('evm:1', ['etherscan_v2']).map((p) => p.id)).toEqual(['etherscan-v2']);
    expect(registry.forChain('evm:1', ['etherscan_v2', 'sandbox_anvil']).map((p) => p.id)).toEqual([
      'evm-otterscan',
      'etherscan-v2',
    ]);
  });

  it('takes the node URL from the environment variable, falling back to the configured default', async () => {
    const node = fakeOtterscanNode(state());
    const configs = loadChainProviderConfig(readFileSync(join(REPO_ROOT, 'config/chain-providers.yaml'), 'utf8'));
    for (const [env, url] of [
      [{ SANDBOX_EVM_RPC_URL: 'http://anvil:8545/' }, 'http://anvil:8545'],
      [{}, 'http://127.0.0.1:8545'],
    ] as const) {
      const http = new FakeEgressClient(node);
      const provider = createChainProviderRegistry(configs, { env }).get('evm-otterscan')!;
      // oxlint-disable-next-line no-await-in-loop
      await provider.getTip('evm:1', testContext(http));
      expect(http.requests.every((r) => r.url === url)).toBe(true);
    }
  });
});
