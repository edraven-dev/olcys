import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import { moreIdentity } from '../../../apps/fixture-site/scripts/lib/more-identity.ts';
import {
  createChainProvider,
  createSolanaRpcProvider,
  KNOWN_SPL_MINTS,
  parseSolanaTransfers,
  type ChainProviderConfig,
  type SolanaParsedTx,
} from '../src/index.ts';
import { FakeEgressClient, fixtureEgress, REPO_ROOT, startFixtureSite, testContext } from './helpers/fake-egress.ts';

const config: ChainProviderConfig = {
  id: 'solana-test',
  kind: 'solana_rpc',
  sourceId: 'solana_public_rpc',
  baseUrl: 'https://solana.example.test',
  chains: ['solana'],
  priority: 1,
};
// Synthetic placeholders: the adapter treats base58 keys as opaque strings.
const ME = 'SyntheticSolanaMe1111111111111111111111111111';
const OTHER = 'SyntheticSolanaOther11111111111111111111111';
const TOKEN_ME = 'SyntheticTokenAccountMe11111111111111111111';
const TOKEN_OTHER = 'SyntheticTokenAccountOther111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENTRY = { signature: 'sig1', slot: 380_000_005, blockTime: 1_800_000_000 };
const ref = { chain: 'solana' as const, address: ME };
const rpcBody = (r: { body?: string | Uint8Array }) =>
  JSON.parse(String(r.body ?? '{}')) as { method: string; params: unknown[]; id: number };

const system = (source: string, destination: string, lamports: number | string) => ({
  program: 'system',
  parsed: { type: 'transfer', info: { source, destination, lamports } },
});
const tx = (instructions: unknown[], inner: unknown[] = []): SolanaParsedTx =>
  ({
    transaction: {
      message: { accountKeys: [ME, OTHER, TOKEN_ME, TOKEN_OTHER].map((pubkey) => ({ pubkey })), instructions },
    },
    meta: {
      innerInstructions: inner,
      preTokenBalances: [
        { accountIndex: 2, mint: USDC, owner: ME, uiTokenAmount: { decimals: 6 } },
        { accountIndex: 3, mint: USDC, owner: OTHER, uiTokenAmount: { decimals: 6 } },
      ],
    },
  }) as SolanaParsedTx;

describe('Solana transfer parsing', () => {
  it('maps a system transfer to SOL with slot as block height', () => {
    const [t] = parseSolanaTransfers(tx([system(ME, OTHER, 1_500_000_000)]), ME, 'f', ENTRY);
    expect(t).toMatchObject({
      chain: 'solana',
      kind: 'native',
      from: ME,
      to: OTHER,
      amount: '1.5',
      blockHeight: 380_000_005,
      blockTime: '2027-01-15T08:00:00.000Z',
      index: 0,
      asset: { symbol: 'SOL', decimals: 9 },
    });
  });

  it('maps token accounts to owners, identifies tokens by mint and labels unknown mints SPL', () => {
    const checked = (mint: string) => ({
      program: 'spl-token',
      parsed: {
        type: 'transferChecked',
        info: {
          source: TOKEN_ME,
          destination: TOKEN_OTHER,
          authority: ME,
          mint,
          tokenAmount: { amount: '2500000', decimals: 6 },
        },
      },
    });
    const [usdc] = parseSolanaTransfers(tx([checked(USDC)]), ME, 'f', ENTRY);
    expect(usdc).toMatchObject({
      kind: 'token',
      from: ME,
      to: OTHER,
      amount: '2.5',
      asset: { symbol: 'USDC', contract: USDC },
    });
    const [unknown] = parseSolanaTransfers(
      tx([checked('UnknownMint11111111111111111111111111111111')]),
      ME,
      'f',
      ENTRY,
    );
    expect(unknown?.asset).toMatchObject({ symbol: 'SPL', contract: 'UnknownMint11111111111111111111111111111111' });
    // A plain `transfer` has no mint: it comes from the token balances.
    const plain = {
      program: 'spl-token',
      parsed: {
        type: 'transfer',
        info: { source: TOKEN_OTHER, destination: TOKEN_ME, authority: OTHER, amount: '1000000' },
      },
    };
    expect(parseSolanaTransfers(tx([plain]), ME, 'f', ENTRY)[0]).toMatchObject({
      from: OTHER,
      to: ME,
      amount: '1',
      asset: { contract: USDC },
    });
    expect(KNOWN_SPL_MINTS[USDC]?.decimals).toBe(6);
  });

  it('indexes inner instructions and drops transfers that do not touch the address', () => {
    const out = parseSolanaTransfers(
      tx(
        [system(OTHER, OTHER, 1), system(OTHER, OTHER, 2), { program: 'x' }],
        [{ index: 2, instructions: [system(OTHER, ME, 7)] }],
      ),
      ME,
      'f',
      ENTRY,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.index).toBe(201);
  });
});

const answerWith = (handler: (m: ReturnType<typeof rpcBody>) => unknown) =>
  new FakeEgressClient((r) => ({ body: handler(rpcBody(r)) }));
const result = (value: unknown) => ({ jsonrpc: '2.0', id: 1, result: value });
const listing = (count: number, prefix: string, failedAt = -1) =>
  Array.from({ length: count }, (_, i) => ({
    signature: `${prefix}${i}`,
    slot: 100 + i,
    blockTime: 1_800_000_000 + i,
    err: i === failedAt ? { InstructionError: [0, 'x'] } : null,
  }));

const transaction = () => result({ ...tx([system(ME, OTHER, 1_000_000_000)]), slot: 1, blockTime: 1 });

describe('Solana provider', () => {
  it('steps back over a skipped slot for the tip; no request carries an identifier', async () => {
    const http = answerWith((m) => {
      if (m.method === 'getSlot') return result(380_000_000);
      return m.params[0] === 380_000_000
        ? { jsonrpc: '2.0', id: 1, error: { code: -32007, message: 'skipped' } }
        : result({ blockhash: 'Bh1' });
    });
    const tip = await createSolanaRpcProvider(config).getTip('solana', testContext(http));
    expect(tip).toMatchObject({ height: 379_999_999, hash: 'Bh1' });
    expect(http.requests).toHaveLength(3);
    expect(http.requests.every((r) => !r.containsIdentifier && r.method === 'POST')).toBe(true);
    expect(http.requests[0]?.body).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}',
    );
  });

  it('reads balances above 2^53 exactly', async () => {
    const http = new FakeEgressClient(() => ({
      body: '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":1152921504606846976}}',
    }));
    const summary = await createSolanaRpcProvider(config).getAddressSummary(ref, testContext(http));
    expect(summary.balance).toBe('1152921504.606846976');
    expect(http.requests[0]?.containsIdentifier).toBe(true);
  });

  it('pages signatures by `before`, never fetches failed transactions and sends the documented transaction options', async () => {
    const first = listing(1000, 'a');
    const http = answerWith((m) => {
      if (m.method === 'getSignaturesForAddress') {
        const options = m.params[1] as { before?: string };
        return result(options.before ? listing(20, 'b') : first);
      }
      return transaction();
    });
    const provider = createSolanaRpcProvider({ ...config, options: { maxTransactions: 5000 } });
    const ctx = testContext(http);
    const one = await provider.listTransfers(ref, {}, ctx);
    expect(one.nextCursor).toBeDefined();
    const two = await provider.listTransfers(ref, { cursor: one.nextCursor! }, ctx);
    expect(two.nextCursor).toBeUndefined();
    const listings = http.requests.map(rpcBody).filter((m) => m.method === 'getSignaturesForAddress');
    const second = listings[1]?.params[1] as { before?: string } | undefined;
    expect(second?.before).toBe('a999');
    const failing = answerWith((m) =>
      m.method === 'getSignaturesForAddress' ? result(listing(3, 'c', 1)) : transaction(),
    );
    await createSolanaRpcProvider(config).listTransfers(ref, {}, testContext(failing));
    const fetched = failing.requests.map(rpcBody).filter((m) => m.method === 'getTransaction');
    expect(fetched.map((m) => m.params[0])).toEqual(['c0', 'c2']);
    expect(
      fetched.every(
        (m) =>
          m.id === 1 &&
          JSON.stringify(m.params[1]) ===
            '{"encoding":"jsonParsed","maxSupportedTransactionVersion":0,"commitment":"finalized"}',
      ),
    ).toBe(true);
  });

  it('stops at the transaction budget and reports the history as truncated', async () => {
    const http = answerWith((m) =>
      m.method === 'getSignaturesForAddress' ? result(listing(501, 's')) : transaction(),
    );
    const page = await createSolanaRpcProvider(config).listTransfers(ref, {}, testContext(http));
    expect(http.requests.filter((r) => rpcBody(r).method === 'getTransaction')).toHaveLength(500);
    expect(page.items).toHaveLength(500);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });

  it('maps JSON-RPC throttling and errors, and is built by the registry', async () => {
    const rate = answerWith(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } }));
    await expect(
      createSolanaRpcProvider(config, { sleep: async () => {} }).getAddressSummary(ref, testContext(rate)),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(createChainProvider(config).id).toBe('solana-test');
    await expect(createSolanaRpcProvider(config).getTip('bitcoin', testContext(rate))).rejects.toMatchObject({
      kind: 'unsupported_chain',
    });
  });
});

describe('Solana provider against the synthetic fixture site', () => {
  let site: FixtureServer;
  let seed = '';
  beforeAll(async () => {
    site = await startFixtureSite();
    seed = (
      JSON.parse(await readFile(join(REPO_ROOT, 'fixtures', 'persona', 'manifest.json'), 'utf8')) as { seed: string }
    ).seed;
  });
  afterAll(() => site.close());

  it('reads tip, balance and a bounded history of the test identity; the demo persona has none', async () => {
    const a = moreIdentity(seed);
    const provider = createSolanaRpcProvider({ ...config, baseUrl: `${site.url}/chain/solana-rpc` });
    const ctx = testContext(fixtureEgress());
    expect(await provider.getTip('solana', ctx)).toMatchObject({ height: 379_999_999 });
    expect((await provider.getAddressSummary({ chain: 'solana', address: a.sol.subject }, ctx)).balance).toBe('2.5');
    const page = await provider.listTransfers({ chain: 'solana', address: a.sol.subject }, {}, ctx);
    expect(page.items.map((t) => `${t.asset.symbol}:${t.amount}:${t.index}`).toSorted()).toEqual([
      'SOL:0.25:201',
      'SOL:1.5:0',
      'USDC:2.5:0',
    ]);
    const persona = await provider.listTransfers(
      { chain: 'solana', address: 'SyntheticUnknown1111111111111111111111111111' },
      {},
      ctx,
    );
    expect(persona.items).toHaveLength(0);
  });
});
