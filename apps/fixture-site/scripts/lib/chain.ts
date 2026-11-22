/**
 * Synthetic on-chain history of the demo persona, rendered in the real provider formats (Esplora, Etherscan V2,
 * TronGrid) so that the production chain adapters can point their base URL at the fixture site. No transaction here
 * exists on any public network; ids are derived from the manifest seed so `--render-only` reproduces them.
 */
import { createHash } from 'node:crypto';
import { createBase58check, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { segwitProgram } from './crypto.ts';

export const SYNTHETIC_MARK = 'SYNTHETIC TEST DATA (OŁCyŚ fixture)';
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
/** "Now" of the demo world; confirmations and tips are computed against it. */
export const DEMO_NOW = '2026-11-21T00:00:00Z';

const base58check = createBase58check(sha256);

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface FixtureRouteOut {
  path: string;
  pathPrefix?: string;
  query?: string;
  params?: Record<string, string>;
  queryPrefix?: string;
  method?: 'GET' | 'POST';
  bodyIncludes?: string[];
  status?: number;
  headers?: Record<string, string>;
  file?: string;
}

export function derive(seed: string, label: string): string {
  return createHash('sha256').update(`${seed}:${label}`).digest('hex');
}

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const sum = (values: readonly bigint[]): bigint => values.reduce((acc, v) => acc + v, 0n);
/** Provider formats (Esplora) carry satoshi as JSON numbers; convert only at write time, exactly. */
function jsonNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`amount ${value} does not fit a JSON number exactly`);
  }
  return Number(value);
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const mark = <T extends object>(value: T): T & { _synthetic: string } => ({ _synthetic: SYNTHETIC_MARK, ...value });

// --- story -------------------------------------------------------------------------------------------------------

type Slots = Readonly<Record<string, string>>;

/** Amounts are exact integers in base units (satoshi, wei, token units) — bigint, never floats. */
interface BtcOutput {
  slot: string;
  value: bigint;
}
interface BtcInput {
  /** `external:<label>` for funding outside the story, else `<txLabel>:<vout>`. */
  from: string;
  slot: string;
  value: bigint;
}
interface BtcStoryTx {
  label: string;
  time: string;
  inputs: BtcInput[];
  outputs: BtcOutput[];
}

/** Values in satoshi. BTC-1 is the persona's declared address; BTC-2 replaces it in variant v2. */
export const BTC_STORY: readonly BtcStoryTx[] = [
  {
    label: 'btc-fund-1',
    time: '2025-03-07T15:02:44Z',
    inputs: [{ from: 'external:src1', slot: 'BTC-SRC-1', value: 30_020_000n }],
    outputs: [{ slot: 'BTC-CP-1', value: 30_000_000n }],
  },
  {
    label: 'btc-fund-2',
    time: '2025-08-28T10:31:09Z',
    inputs: [{ from: 'external:src2', slot: 'BTC-SRC-2', value: 20_015_000n }],
    outputs: [{ slot: 'BTC-CP-2', value: 20_000_000n }],
  },
  {
    label: 'btc-a',
    time: '2025-03-14T09:21:05Z',
    inputs: [{ from: 'btc-fund-1:0', slot: 'BTC-CP-1', value: 30_000_000n }],
    outputs: [
      { slot: 'BTC-1', value: 25_000_000n },
      { slot: 'BTC-CP-1', value: 4_990_000n },
    ],
  },
  {
    label: 'btc-b',
    time: '2025-09-02T17:44:30Z',
    inputs: [{ from: 'btc-fund-2:0', slot: 'BTC-CP-2', value: 20_000_000n }],
    outputs: [
      { slot: 'BTC-1', value: 10_000_000n },
      { slot: 'BTC-CP-2', value: 9_990_000n },
    ],
  },
  {
    label: 'btc-c',
    time: '2026-02-11T12:03:51Z',
    inputs: [{ from: 'btc-a:0', slot: 'BTC-1', value: 25_000_000n }],
    outputs: [
      { slot: 'BTC-CP-3', value: 15_000_000n },
      { slot: 'BTC-1', value: 9_980_000n },
    ],
  },
  {
    label: 'btc-d',
    time: '2026-10-30T08:12:40Z',
    inputs: [{ from: 'btc-a:1', slot: 'BTC-CP-1', value: 4_990_000n }],
    outputs: [
      { slot: 'BTC-1', value: 4_000_000n },
      { slot: 'BTC-CP-1', value: 980_000n },
    ],
  },
  {
    label: 'btc-e',
    time: '2026-11-18T19:30:00Z',
    inputs: [
      { from: 'btc-b:0', slot: 'BTC-1', value: 10_000_000n },
      { from: 'btc-c:1', slot: 'BTC-1', value: 9_980_000n },
    ],
    outputs: [{ slot: 'BTC-2', value: 19_960_000n }],
  },
];

interface EvmStoryTx {
  label: string;
  /** Use a fixed slot value as the hash (the deposit tx quoted in the forum post). */
  hashSlot?: string;
  time: string;
  from: string;
  to: string;
  /** Wei. */
  value: bigint;
  gasPriceGwei: number;
}

const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;
const sweepValue = (amount: bigint, gasPriceGwei: number): bigint => amount - 21_000n * BigInt(gasPriceGwei) * GWEI;

/** ETH-1 is an exchange deposit address: it receives the persona's deposit (tx D1) and sweeps it to HOT-1. */
export const EVM_STORY: readonly EvmStoryTx[] = [
  {
    label: 'eth-drips-1',
    time: '2026-06-15T10:00:00Z',
    from: 'ETH-CP-2',
    to: 'ETH-2',
    value: (2n * ETH) / 100n,
    gasPriceGwei: 9,
  },
  {
    label: 'eth-drips-2',
    time: '2026-08-02T14:30:00Z',
    from: 'ETH-CP-3',
    to: 'ETH-2',
    value: (15n * ETH) / 1000n,
    gasPriceGwei: 11,
  },
  {
    label: 'eth-drips-3',
    time: '2026-10-21T08:45:00Z',
    from: 'ETH-CP-4',
    to: 'ETH-2',
    value: (5n * ETH) / 100n,
    gasPriceGwei: 14,
  },
  {
    label: 'eth-deposit',
    hashSlot: 'TX-DECOY',
    time: '2026-11-03T10:15:23Z',
    from: 'ETH-CP-1',
    to: 'ETH-1',
    value: (15n * ETH) / 10n,
    gasPriceGwei: 18,
  },
  {
    label: 'eth-sweep',
    time: '2026-11-03T10:42:11Z',
    from: 'ETH-1',
    to: 'HOT-1',
    value: sweepValue((15n * ETH) / 10n, 21),
    gasPriceGwei: 21,
  },
  {
    label: 'eth-other-deposit',
    time: '2026-11-03T11:05:00Z',
    from: 'ETH-CP-5',
    to: 'HOT-1',
    value: (8n * ETH) / 10n,
    gasPriceGwei: 20,
  },
  {
    label: 'eth-withdrawal',
    time: '2026-11-03T12:00:00Z',
    from: 'HOT-1',
    to: 'ETH-CP-6',
    value: (325n * ETH) / 100n,
    gasPriceGwei: 20,
  },
];

/** Opening balances (wei) so that every balance stays non-negative. */
const EVM_OPENING: Readonly<Record<string, bigint>> = {
  'HOT-1': 412n * ETH,
  'ETH-CP-1': 2n * ETH,
  'ETH-CP-2': 1n * ETH,
  'ETH-CP-3': 1n * ETH,
  'ETH-CP-4': 1n * ETH,
  'ETH-CP-5': 5n * ETH,
};

interface TronStoryTransfer {
  label: string;
  time: string;
  from: string;
  to: string;
  /** USDT in whole units (6 decimals on chain). */
  usdt: bigint;
}

/**
 * TRON-1 (the persona's USDT wallet): swap proceeds from a DEX pair, 60 % sent to an exchange deposit address within
 * two days (stablecoin swap then exit), later six round-number transfers to unrelated addresses (P2P pattern).
 * TRON-2 is the scam address reported by a third-party channel.
 */
export const TRON_STORY: readonly TronStoryTransfer[] = [
  { label: 'tron-swap', time: '2026-08-20T12:00:00Z', from: 'TRON-DEX', to: 'TRON-1', usdt: 5000n },
  { label: 'tron-deposit', time: '2026-08-22T09:00:00Z', from: 'TRON-1', to: 'TRON-DEP', usdt: 3000n },
  { label: 'tron-sweep', time: '2026-08-22T11:30:00Z', from: 'TRON-DEP', to: 'TRON-HOT', usdt: 3000n },
  { label: 'tron-income', time: '2026-10-01T10:00:00Z', from: 'TRON-CP-1', to: 'TRON-1', usdt: 4000n },
  { label: 'tron-p2p-1', time: '2026-10-14T18:20:00Z', from: 'TRON-1', to: 'TRON-P2P-1', usdt: 500n },
  { label: 'tron-p2p-2', time: '2026-10-18T09:45:00Z', from: 'TRON-1', to: 'TRON-P2P-2', usdt: 1000n },
  { label: 'tron-p2p-3', time: '2026-10-22T20:10:00Z', from: 'TRON-1', to: 'TRON-P2P-3', usdt: 500n },
  { label: 'tron-p2p-4', time: '2026-10-27T13:05:00Z', from: 'TRON-1', to: 'TRON-P2P-4', usdt: 1000n },
  { label: 'tron-p2p-5', time: '2026-11-01T16:40:00Z', from: 'TRON-1', to: 'TRON-P2P-5', usdt: 500n },
  { label: 'tron-p2p-6', time: '2026-11-05T11:15:00Z', from: 'TRON-1', to: 'TRON-P2P-6', usdt: 500n },
  { label: 'tron-victim-1', time: '2026-11-09T14:00:00Z', from: 'TRON-CP-2', to: 'TRON-2', usdt: 1200n },
  { label: 'tron-victim-2', time: '2026-11-11T08:30:00Z', from: 'TRON-CP-3', to: 'TRON-2', usdt: 800n },
  { label: 'tron-victim-3', time: '2026-11-13T21:50:00Z', from: 'TRON-CP-4', to: 'TRON-2', usdt: 2500n },
];

/** Opening USDT balances (whole units) of senders whose funding lies outside the story. */
const TRON_OPENING: Readonly<Record<string, bigint>> = {
  'TRON-DEX': 250_000n,
  'TRON-CP-1': 10_000n,
  'TRON-CP-2': 5_000n,
  'TRON-CP-3': 5_000n,
  'TRON-CP-4': 5_000n,
};
const USDT_UNIT = 1_000_000n;

/** Slots used by the stories (beyond the persona's own), with their manifest roles. */
export const STORY_SLOTS: Readonly<Record<string, { chain: string; role: string }>> = {
  // Funding sources outside the story: their own history is not rendered.
  'BTC-SRC-1': { chain: 'bitcoin', role: 'external_source' },
  'BTC-SRC-2': { chain: 'bitcoin', role: 'external_source' },
  'BTC-CP-1': { chain: 'bitcoin', role: 'counterparty' },
  'BTC-CP-2': { chain: 'bitcoin', role: 'counterparty' },
  'BTC-CP-3': { chain: 'bitcoin', role: 'counterparty' },
  'ETH-CP-1': { chain: 'evm:1', role: 'persona_undisclosed_wallet' },
  'ETH-CP-2': { chain: 'evm:1', role: 'donor' },
  'ETH-CP-3': { chain: 'evm:1', role: 'donor' },
  'ETH-CP-4': { chain: 'evm:1', role: 'donor' },
  'ETH-CP-5': { chain: 'evm:1', role: 'exchange_deposit_other_customer' },
  'ETH-CP-6': { chain: 'evm:1', role: 'exchange_withdrawal_recipient' },
  'TRON-DEX': { chain: 'tron', role: 'dex_pair' },
  'TRON-DEP': { chain: 'tron', role: 'exchange_deposit' },
  'TRON-HOT': { chain: 'tron', role: 'exchange_hot_wallet' },
  'TRON-CP-1': { chain: 'tron', role: 'counterparty' },
  'TRON-CP-2': { chain: 'tron', role: 'scam_victim' },
  'TRON-CP-3': { chain: 'tron', role: 'scam_victim' },
  'TRON-CP-4': { chain: 'tron', role: 'scam_victim' },
  'TRON-P2P-1': { chain: 'tron', role: 'p2p_counterparty' },
  'TRON-P2P-2': { chain: 'tron', role: 'p2p_counterparty' },
  'TRON-P2P-3': { chain: 'tron', role: 'p2p_counterparty' },
  'TRON-P2P-4': { chain: 'tron', role: 'p2p_counterparty' },
  'TRON-P2P-5': { chain: 'tron', role: 'p2p_counterparty' },
  'TRON-P2P-6': { chain: 'tron', role: 'p2p_counterparty' },
};

// --- Esplora -----------------------------------------------------------------------------------------------------

const btcHeight = (iso: string): number =>
  977_000 + Math.round((Date.parse(iso) - Date.parse('2026-11-01T00:00:00Z')) / 600_000);

function scriptPubKey(address: string, value: bigint) {
  const program = hex.encode(segwitProgram(address));
  return {
    scriptpubkey: `0014${program}`,
    scriptpubkey_asm: `OP_0 OP_PUSHBYTES_20 ${program}`,
    scriptpubkey_type: 'v0_p2wpkh',
    scriptpubkey_address: address,
    value: jsonNumber(value),
  };
}

function esploraTxs(seed: string, slots: Slots) {
  const txid = (label: string) => derive(seed, `btc-txid:${label}`);
  return BTC_STORY.map((tx) => {
    const fee = sum(tx.inputs.map((i) => i.value)) - sum(tx.outputs.map((o) => o.value));
    if (fee < 0n) throw new Error(`${tx.label} creates value`);
    const vsize = 11 + 68 * tx.inputs.length + 31 * tx.outputs.length;
    const height = btcHeight(tx.time);
    return {
      tx,
      json: mark({
        txid: txid(tx.label),
        version: 2,
        locktime: 0,
        vin: tx.inputs.map((input, index) => {
          const [prevLabel, vout] = input.from.split(':');
          const external = prevLabel === 'external';
          return {
            txid: external ? derive(seed, `btc-funding:${vout}`) : txid(prevLabel ?? ''),
            vout: external ? 0 : Number(vout),
            prevout: scriptPubKey(slots[input.slot] ?? '', input.value),
            scriptsig: '',
            scriptsig_asm: '',
            witness: [
              `${derive(seed, `btc-sig:${tx.label}:${index}`)}01`,
              `02${derive(seed, `btc-pub:${input.slot}`)}`,
            ],
            is_coinbase: false,
            sequence: 4_294_967_293,
          };
        }),
        vout: tx.outputs.map((output) => scriptPubKey(slots[output.slot] ?? '', output.value)),
        size: vsize + 30 * tx.inputs.length,
        weight: vsize * 4,
        fee: jsonNumber(fee),
        status: {
          confirmed: true,
          block_height: height,
          block_hash: derive(seed, `btc-block:${height}`),
          block_time: seconds(tx.time),
        },
      }),
    };
  });
}

function renderEsplora(seed: string, slots: Slots, btcSlots: readonly string[]): GeneratedFile[] {
  const txs = esploraTxs(seed, slots);
  const files: GeneratedFile[] = [];
  for (const slot of btcSlots) {
    const address = slots[slot] ?? '';
    const involved = txs.filter(
      ({ tx }) => tx.inputs.some((i) => i.slot === slot) || tx.outputs.some((o) => o.slot === slot),
    );
    const funded = BTC_STORY.flatMap((tx) => tx.outputs.filter((o) => o.slot === slot));
    const spent = BTC_STORY.flatMap((tx) => tx.inputs.filter((i) => i.slot === slot));
    const fundedSum = sum(funded.map((o) => o.value));
    const spentSum = sum(spent.map((i) => i.value));
    if (fundedSum < spentSum) {
      throw new Error(`${slot} spends more than it received in the BTC story`);
    }
    const stats = {
      funded_txo_count: funded.length,
      funded_txo_sum: jsonNumber(fundedSum),
      spent_txo_count: spent.length,
      spent_txo_sum: jsonNumber(spentSum),
      tx_count: involved.length,
    };
    const empty = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 };
    const base = `chain/esplora/api/address/${address}`;
    files.push(
      { path: `${base}/index.json`, content: json(mark({ address, chain_stats: stats, mempool_stats: empty })) },
      { path: `${base}/txs.json`, content: json(involved.map(({ json: tx }) => tx).toReversed()) },
    );
  }
  files.push({ path: 'chain/esplora/api/blocks/tip/height.txt', content: `${btcHeight(DEMO_NOW)}` });
  return files;
}

// --- Etherscan V2 --------------------------------------------------------------------------------------------------

const ETHERSCAN_PATH = '/chain/etherscan/v2/api';
const route = (params: Record<string, string>, file: string): FixtureRouteOut => ({
  path: ETHERSCAN_PATH,
  params: { chainid: '1', ...params },
  file,
});
const evmBlock = (iso: string): number =>
  26_400_000 + Math.round((Date.parse(iso) - Date.parse('2026-11-01T00:00:00Z')) / 12_000);

function renderEtherscan(
  seed: string,
  slots: Slots,
  evmSlots: readonly string[],
  contractCode: Readonly<Record<string, string>>,
): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const tip = evmBlock(DEMO_NOW);
  const lower = (slot: string) => (slots[slot] ?? '').toLowerCase();
  const nonces = new Map<string, number>();
  const rows = EVM_STORY.map((tx, index) => {
    const block = evmBlock(tx.time);
    const nonce = nonces.get(tx.from) ?? 0;
    nonces.set(tx.from, nonce + 1);
    const hash = tx.hashSlot ? (slots[tx.hashSlot] ?? '') : `0x${derive(seed, `eth-hash:${tx.label}`)}`;
    return {
      tx,
      row: {
        blockNumber: String(block),
        timeStamp: String(seconds(tx.time)),
        hash: hash.toLowerCase(),
        nonce: String(nonce),
        blockHash: `0x${derive(seed, `eth-block:${block}`)}`,
        transactionIndex: String(40 + index),
        from: lower(tx.from),
        to: lower(tx.to),
        value: tx.value.toString(),
        gas: '21000',
        gasPrice: (BigInt(tx.gasPriceGwei) * GWEI).toString(),
        isError: '0',
        txreceipt_status: '1',
        input: '0x',
        contractAddress: '',
        cumulativeGasUsed: String(1_000_000 + 21_000 * index),
        gasUsed: '21000',
        confirmations: String(tip - block + 1),
        methodId: '0x',
        functionName: '',
      },
    };
  });

  const files: GeneratedFile[] = [];
  const routes: FixtureRouteOut[] = [];
  for (const slot of evmSlots) {
    const address = lower(slot);
    const mine = rows.filter(({ tx }) => tx.from === slot || tx.to === slot);
    let balance = EVM_OPENING[slot] ?? 0n;
    for (const { tx } of mine) {
      if (tx.to === slot) balance += tx.value;
      if (tx.from === slot) balance -= tx.value + 21_000n * BigInt(tx.gasPriceGwei) * GWEI;
    }
    if (balance < 0n) throw new Error(`${slot} has a negative balance in the EVM story`);
    const dir = `chain/etherscan/${address}`;
    files.push(
      {
        path: `${dir}/txlist.json`,
        content: json(
          mine.length
            ? mark({ status: '1', message: 'OK', result: mine.map(({ row }) => row) })
            : mark({ status: '0', message: 'No transactions found', result: [] }),
        ),
      },
      { path: `${dir}/balance.json`, content: json(mark({ status: '1', message: 'OK', result: balance.toString() })) },
    );
    routes.push(
      route({ module: 'account', action: 'txlist', address }, `${dir}/txlist.json`),
      route({ module: 'account', action: 'balance', address }, `${dir}/balance.json`),
    );
  }
  for (const [slot, code] of Object.entries(contractCode)) {
    const file = `chain/etherscan/${lower(slot)}/code.json`;
    files.push({ path: file, content: json(mark({ jsonrpc: '2.0', id: 1, result: code })) });
    routes.push(
      route({ module: 'proxy', action: 'eth_getCode', address: lower(slot) }, file),
      // A plain contract: no Safe singleton or proxy slot set, every probed function reverts (address-type probes).
      route({ module: 'proxy', action: 'eth_call', to: lower(slot) }, 'chain/etherscan/call-revert.json'),
    );
  }
  files.push(
    {
      path: 'chain/etherscan/empty-list.json',
      content: json(mark({ status: '0', message: 'No transactions found', result: [] })),
    },
    { path: 'chain/etherscan/zero-balance.json', content: json(mark({ status: '1', message: 'OK', result: '0' })) },
    { path: 'chain/etherscan/code-eoa.json', content: json(mark({ jsonrpc: '2.0', id: 1, result: '0x' })) },
    {
      path: 'chain/etherscan/storage-zero.json',
      content: json(mark({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(64)}` })),
    },
    { path: 'chain/etherscan/call-empty.json', content: json(mark({ jsonrpc: '2.0', id: 1, result: '0x' })) },
    {
      path: 'chain/etherscan/call-revert.json',
      content: json(mark({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })),
    },
    {
      path: 'chain/etherscan/block-number.json',
      content: json(mark({ jsonrpc: '2.0', id: 83, result: `0x${tip.toString(16)}` })),
    },
  );
  // Fallbacks after the per-address routes: unknown addresses have no history; every address is an EOA (zero
  // storage, a call to an account without code returns no data).
  routes.push(
    route({ module: 'account', action: 'txlist' }, 'chain/etherscan/empty-list.json'),
    route({ module: 'account', action: 'txlistinternal' }, 'chain/etherscan/empty-list.json'),
    route({ module: 'account', action: 'tokentx' }, 'chain/etherscan/empty-list.json'),
    route({ module: 'account', action: 'balance' }, 'chain/etherscan/zero-balance.json'),
    route({ module: 'proxy', action: 'eth_getCode' }, 'chain/etherscan/code-eoa.json'),
    route({ module: 'proxy', action: 'eth_getStorageAt' }, 'chain/etherscan/storage-zero.json'),
    route({ module: 'proxy', action: 'eth_call' }, 'chain/etherscan/call-empty.json'),
    route({ module: 'proxy', action: 'eth_blockNumber' }, 'chain/etherscan/block-number.json'),
  );
  return { files, routes };
}

// --- TronGrid ------------------------------------------------------------------------------------------------------

const tronHex = (address: string): string => hex.encode(base58check.decode(address));

const TRONGRID_GETCONTRACT = '/chain/trongrid/wallet/getcontract';

function renderTrongrid(seed: string, slots: Slots, tronSlots: readonly string[]): GeneratedFile[] {
  const at = Date.parse(DEMO_NOW);
  // `wallet/getcontract` answers `{}` for an account that is not a smart contract (every synthetic TRON address).
  const files: GeneratedFile[] = [{ path: 'chain/trongrid/wallet/getcontract-none.json', content: json(mark({})) }];
  for (const slot of tronSlots) {
    const address = slots[slot] ?? '';
    const mine = TRON_STORY.filter((t) => t.from === slot || t.to === slot);
    const data = mine
      .map((t) => ({
        transaction_id: derive(seed, `tron-tx:${t.label}`),
        token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6, name: 'Tether USD' },
        block_timestamp: Date.parse(t.time),
        from: slots[t.from] ?? '',
        to: slots[t.to] ?? '',
        type: 'Transfer',
        value: String(t.usdt * USDT_UNIT),
      }))
      .toReversed();
    const usdt = (TRON_OPENING[slot] ?? 0n) + sum(mine.map((t) => (t.to === slot ? t.usdt : -t.usdt)));
    if (usdt < 0n) throw new Error(`${slot} has a negative USDT balance in the TRON story`);
    const base = `chain/trongrid/v1/accounts/${address}`;
    files.push(
      {
        path: `${base}/transactions/trc20.json`,
        content: json(mark({ data, success: true, meta: { at, page_size: data.length } })),
      },
      {
        path: `${base}/index.json`,
        content: json(
          mark({
            data: [
              {
                address: tronHex(address),
                balance: 35_000_000,
                create_time: mine.length ? Date.parse(mine[0]?.time ?? DEMO_NOW) - 86_400_000 : at,
                trc20: usdt > 0n ? [{ [USDT_TRC20]: String(usdt * USDT_UNIT) }] : [],
              },
            ],
            success: true,
            meta: { at, page_size: 1 },
          }),
        ),
      },
    );
  }
  return files;
}

// --- NBP Table A (synthetic) ---------------------------------------------------------------------------------------

/** Months of USD rates served: they cover the lookback before every transfer of the stories. */
export const NBP_FIRST_MONTH = '2025-02';
export const NBP_LAST_MONTH = '2026-11';
const NBP_PREFIX = '/nbp/api/exchangerates/rates/a/usd';

function nbpMonths(): string[] {
  const months: string[] = [];
  let [y, m] = NBP_FIRST_MONTH.split('-').map(Number) as [number, number];
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    months.push(month);
    if (month === NBP_LAST_MONTH) return months;
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
}

/**
 * Made-up USD/PLN Table A averages in the real NBP JSON shape: one table per business day (Mon-Fri), numbering and
 * values are synthetic (a deterministic wave around 3.9), never real NBP data. The routes ignore the end of the
 * requested range, so the current month works on any day.
 */
function renderNbp(): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const files: GeneratedFile[] = [];
  const routes: FixtureRouteOut[] = [];
  let tableNo = 0;
  for (const month of nbpMonths()) {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const rates: string[] = [];
    for (let d = 1; d <= days; d++) {
      const date = new Date(Date.UTC(y, m - 1, d));
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      tableNo += 1;
      const mid = (3.8 + (((tableNo * 37) % 400) + 1) / 10_000 + 0.0001).toFixed(4);
      rates.push(
        `    { "no": "SYN${String(tableNo).padStart(3, '0')}/A/NBP/${y}", "effectiveDate": "${date.toISOString().slice(0, 10)}", "mid": ${mid} }`,
      );
    }
    const file = `nbp/api/exchangerates/rates/a/usd/${month}.json`;
    files.push({
      path: file,
      content: `{\n  "_synthetic": "${SYNTHETIC_MARK}",\n  "table": "A",\n  "currency": "dolar amerykański (SYNTHETIC)",\n  "code": "USD",\n  "rates": [\n${rates.join(',\n')}\n  ]\n}\n`,
    });
    routes.push({ path: `${NBP_PREFIX}/${month}-01/`, pathPrefix: `${NBP_PREFIX}/${month}-01/`, file });
  }
  return { files, routes };
}

export function renderChain(
  seed: string,
  slots: Slots,
  bySlotChain: { btc: readonly string[]; evm: readonly string[]; tron: readonly string[] },
  contractCode: Readonly<Record<string, string>> = {},
): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const etherscan = renderEtherscan(seed, slots, bySlotChain.evm, contractCode);
  const nbp = renderNbp();
  return {
    files: [
      ...nbp.files,
      ...renderEsplora(seed, slots, bySlotChain.btc),
      ...etherscan.files,
      ...renderTrongrid(seed, slots, bySlotChain.tron),
    ],
    routes: [
      ...nbp.routes,
      {
        path: '/chain/esplora/api/blocks/tip/height',
        file: 'chain/esplora/api/blocks/tip/height.txt',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
      ...etherscan.routes,
      { path: TRONGRID_GETCONTRACT, file: 'chain/trongrid/wallet/getcontract-none.json' },
    ],
  };
}
