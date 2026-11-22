/**
 * EVM chains over a self-hosted node that serves the Otterscan API (`ots_*`, API level >= 8): Erigon in production
 * (no address ever leaves the agency's network) and Anvil in the demo sandbox. Plain JSON-RPC cannot list an
 * address's history; `ots_searchTransactionsBefore` can. Listing walks three stages, newest first:
 *   1. `ots`      - `ots_searchTransactionsBefore` pages (transactions + receipts); native transfers from the
 *                   transactions, internal transfers from `ots_getInternalOperations` of contract calls;
 *   2. `tokenOut` - `eth_getLogs` for ERC-20 `Transfer` with the address as sender (topic1), chunked by block range;
 *   3. `tokenIn`  - the same with the address as recipient (topic2).
 * Every call is a JSON-RPC POST with a deterministic body (fixed key order, one fixed `id` per method) so cassette
 * keys are stable. The Otterscan API level is checked once per run; below the minimum the provider reports
 * `provider_unavailable` and is not contacted again in that run.
 */
import type {
  AddressRef,
  AddressSummary,
  ChainCallResult,
  ChainId,
  ChainProvider,
  ChainTip,
  Id,
  NormalizedTransfer,
  RunContext,
  SourceId,
  TransferPage,
} from '@olcys/core';
import { KNOWN_CHAINS } from '@olcys/core';
import type { ChainProviderConfig, ProviderDeps } from './config.ts';
import { ChainProviderError, type ChainErrorKind } from './errors.ts';
import { isRecord } from './json.ts';
import { CircuitBreaker, requestJson } from './request.ts';
import { baseUnitsToDecimal, decodeCursor, encodeCursor, isoFromSeconds, rowAmount, type SkipReason } from './units.ts';

export const OTTERSCAN_PROVIDER_ID = 'evm-otterscan';
export const DEFAULT_OTTERSCAN_PAGE_SIZE = 25;
export const DEFAULT_OTTERSCAN_MIN_API_LEVEL = 8;
/** Blocks per `eth_getLogs` request (indexed-topic queries on a self-hosted node; lower it for a restricted node). */
export const DEFAULT_LOG_BLOCK_RANGE = 5_000_000;

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SYMBOL_SELECTOR = '0x95d89b41';
const DECIMALS_SELECTOR = '0x313ce567';
const HEX = /^0x[0-9a-f]*$/i;
const QUANTITY = /^0x[0-9a-f]+$/i;

/** One fixed JSON-RPC id per method: bodies are byte-identical for identical calls (cassette keys). */
const RPC_ID = {
  ots_getApiLevel: 1,
  eth_blockNumber: 2,
  eth_getBlockByNumber: 3,
  ots_searchTransactionsBefore: 4,
  ots_getInternalOperations: 5,
  eth_getLogs: 6,
  eth_call: 7,
  eth_getCode: 8,
  eth_getStorageAt: 9,
  eth_getBalance: 10,
  eth_getTransactionCount: 11,
  eth_chainId: 12,
} as const;
type RpcMethod = keyof typeof RPC_ID;

export interface OtterscanEvmProviderOptions {
  /** Provider id (default `evm-otterscan`). */
  id?: string;
  chains: readonly ChainId[];
  /** JSON-RPC endpoint of the node (`SANDBOX_EVM_RPC_URL` in the demo, the agency's Erigon in production). */
  rpcUrl: string;
  sourceId: SourceId;
  /** `ots_searchTransactionsBefore` page size (default 25; the node may return a whole block beyond it). */
  pageSize?: number;
  /** Minimum `ots_getApiLevel` (default 8). */
  minApiLevel?: number;
  /** Blocks per `eth_getLogs` request (default 5 000 000). */
  logBlockRange?: number;
}

type Stage = 'ots' | 'tokenOut' | 'tokenIn';
const NEXT_STAGE: Record<Stage, Stage | undefined> = { ots: 'tokenOut', tokenOut: 'tokenIn', tokenIn: undefined };

export interface OtterscanCursor {
  stage: Stage;
  /** Newest block of the snapshot (the pinned tip); the log stages need it as their starting point. */
  to?: number;
  /** `ots`: exclusive upper block (0 = from the newest). Log stages: inclusive upper block of the next chunk (always explicit). */
  before: number;
}

interface RpcEnvelope {
  result?: unknown;
  error?: unknown;
}

interface Tx {
  hash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  value: string;
  input?: string;
}
interface Receipt {
  transactionHash: string;
  status?: string;
  contractAddress?: string | null;
  timestamp?: string;
}
interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash?: string;
  blockTimestamp?: string;
  transactionHash: string;
  logIndex: string;
}
interface InternalOp {
  type?: number;
  from: string;
  to: string | null;
  value: string;
}

function nativeAsset(chain: ChainId): { symbol: string; decimals: number } {
  const info = KNOWN_CHAINS.find((c) => c.id === chain);
  return { symbol: info?.nativeAsset ?? 'ETH', decimals: info?.decimals ?? 18 };
}

const hexToInt = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !QUANTITY.test(value)) return undefined;
  const n = Number.parseInt(value, 16);
  return Number.isSafeInteger(n) ? n : undefined;
};
const quantity = (n: number): string => `0x${n.toString(16)}`;
/** Hex quantity to a base-10 integer string (wei amounts exceed 2^53). */
const hexToDecimalText = (value: unknown): string | undefined =>
  typeof value === 'string' && QUANTITY.test(value) ? BigInt(value).toString() : undefined;

function isRevert(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error['code'] === 3 || /revert/i.test(String(error['message'] ?? ''));
}

/** JSON-RPC verdict of a body: a result, or an error mapped to a kind (`eth_call` reverts are answers). */
export function classifyOtterscan(body: unknown): 'ok' | ChainErrorKind {
  if (!isRecord(body) || !('jsonrpc' in body)) return 'invalid_response';
  const error = body['error'];
  if (error === undefined) return 'result' in body ? 'ok' : 'invalid_response';
  if (isRevert(error)) return 'ok';
  if (isRecord(error)) {
    const message = String(error['message'] ?? '').toLowerCase();
    if (error['code'] === -32601 || message.includes('method not found') || message.includes('not available')) {
      return 'provider_unavailable';
    }
    if (error['code'] === -32602 || message.includes('invalid argument') || message.includes('invalid params')) {
      return 'invalid_request';
    }
    if (/range|too many|more than \d+|limit exceeded|response size|query returned/.test(message)) {
      return 'window_exceeded';
    }
  }
  return 'upstream_error';
}

/** Decodes an ABI `string` return (dynamic) or a legacy `bytes32` symbol; untrusted text is stripped and capped. */
export function decodeAbiString(hex: string): string | undefined {
  if (!HEX.test(hex)) return undefined;
  const body = hex.slice(2);
  let bytes: Buffer;
  if (body.length === 64) {
    bytes = Buffer.from(body, 'hex');
  } else if (body.length >= 128) {
    const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
    const length = Number.parseInt(body.slice(offset, offset + 64), 16) * 2;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset + 64 + length > body.length) {
      return undefined;
    }
    bytes = Buffer.from(body.slice(offset + 64, offset + 64 + length), 'hex');
  } else {
    return undefined;
  }
  // Symbols come from untrusted contracts: control characters are dropped, the length capped.
  return [...bytes.toString('utf8')]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 32);
}

const addressOfTopic = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();
const topicOfAddress = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

export function createOtterscanEvmProvider(
  options: OtterscanEvmProviderOptions,
  deps: Pick<ProviderDeps, 'sleep'> = {},
): ChainProvider {
  const id = options.id ?? OTTERSCAN_PROVIDER_ID;
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_OTTERSCAN_PAGE_SIZE));
  const minApiLevel = options.minApiLevel ?? DEFAULT_OTTERSCAN_MIN_API_LEVEL;
  const logRange = Math.max(1, Math.floor(options.logBlockRange ?? DEFAULT_LOG_BLOCK_RANGE));
  const rpcUrl = options.rpcUrl.replace(/\/+$/, '');
  const breaker = new CircuitBreaker();
  const sleep = deps.sleep;
  // Per run: the API-level verdict and block timestamps / token metadata (never shared between runs).
  const ready = new Map<string, Promise<void>>();
  const timestamps = new Map<string, number>();
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();

  const requireChain = (chain: ChainId): void => {
    if (!options.chains.includes(chain) || !/^evm:\d+$/.test(chain)) {
      throw new ChainProviderError('unsupported_chain', id, `${chain} is not configured for this provider`);
    }
  };

  async function rpcRaw(
    ctx: RunContext,
    method: RpcMethod,
    params: readonly unknown[],
    purpose: string,
    identifying: boolean,
  ): Promise<{ envelope: RpcEnvelope; fetchId: Id }> {
    const { data, fetchId } = await requestJson<RpcEnvelope>(
      ctx,
      {
        providerId: id,
        sourceId: options.sourceId,
        url: rpcUrl,
        method: 'POST',
        // Fixed key order and one id per method: identical calls give byte-identical bodies.
        body: JSON.stringify({ jsonrpc: '2.0', id: RPC_ID[method], method, params }),
        headers: { 'content-type': 'application/json' },
        purpose,
        containsIdentifier: identifying,
      },
      { classify: classifyOtterscan, breaker, ...(sleep ? { sleep } : {}) },
    );
    return { envelope: data, fetchId };
  }

  async function rpc(
    ctx: RunContext,
    method: RpcMethod,
    params: readonly unknown[],
    purpose: string,
    identifying: boolean,
  ): Promise<{ result: unknown; fetchId: Id }> {
    const { envelope, fetchId } = await rpcRaw(ctx, method, params, purpose, identifying);
    if (envelope.error !== undefined) {
      throw new ChainProviderError('upstream_error', id, `${method} failed`, { fetchId });
    }
    return { result: envelope.result, fetchId };
  }

  /** `ots_getApiLevel` >= minimum, once per run; a failure that proves the node unusable stops the provider. */
  function ensureReady(ctx: RunContext): Promise<void> {
    let check = ready.get(ctx.runId);
    if (!check) {
      check = (async () => {
        let level: unknown;
        let fetchId: Id;
        try {
          ({ result: level, fetchId } = await rpc(ctx, 'ots_getApiLevel', [], 'otterscan api level check', false));
        } catch (error) {
          if (error instanceof ChainProviderError && error.kind === 'provider_unavailable') {
            breaker.trip(ctx.runId, 'provider_unavailable', 'node does not serve the Otterscan API');
          }
          throw error;
        }
        if (typeof level !== 'number' || !Number.isSafeInteger(level)) {
          throw new ChainProviderError('invalid_response', id, 'bad ots_getApiLevel result', { fetchId });
        }
        if (level < minApiLevel) {
          const reason = `Otterscan API level ${level} < required ${minApiLevel}`;
          breaker.trip(ctx.runId, 'provider_unavailable', reason);
          throw new ChainProviderError('provider_unavailable', id, reason, { fetchId });
        }
        // The node must serve the chain it is configured for (a mislabelled chain would poison every record).
        const { result: nodeChain, fetchId: chainFetchId } = await rpc(
          ctx,
          'eth_chainId',
          [],
          'evm chain id check',
          false,
        );
        const nodeChainId = hexToInt(nodeChain);
        if (nodeChainId === undefined) {
          throw new ChainProviderError('invalid_response', id, 'bad eth_chainId result', { fetchId: chainFetchId });
        }
        const wrong = options.chains.filter((chain) => chain !== `evm:${nodeChainId}`);
        if (wrong.length > 0) {
          const reason = `node reports chain id ${nodeChainId}, configured for ${wrong.join(', ')}`;
          breaker.trip(ctx.runId, 'provider_unavailable', reason);
          throw new ChainProviderError('provider_unavailable', id, reason, { fetchId: chainFetchId });
        }
      })();
      ready.set(ctx.runId, check);
      // A transient failure is retried by the next call; a verdict about the node is final for the run.
      check.catch((error: unknown) => {
        if (!(error instanceof ChainProviderError && error.kind === 'provider_unavailable')) ready.delete(ctx.runId);
      });
    }
    return check;
  }

  async function blockTime(ctx: RunContext, height: number): Promise<number> {
    const key = `${ctx.runId}|${height}`;
    const cached = timestamps.get(key);
    if (cached !== undefined) return cached;
    const { result, fetchId } = await rpc(
      ctx,
      'eth_getBlockByNumber',
      [quantity(height), false],
      'evm block timestamp',
      false,
    );
    const seconds = isRecord(result) ? hexToInt(result['timestamp']) : undefined;
    if (seconds === undefined)
      throw new ChainProviderError('invalid_response', id, 'block has no timestamp', { fetchId });
    timestamps.set(key, seconds);
    return seconds;
  }

  async function ethCallText(ctx: RunContext, to: string, data: string): Promise<string | undefined> {
    const { envelope } = await rpcRaw(ctx, 'eth_call', [{ to, data }, 'latest'], 'evm token metadata', true);
    if (envelope.error !== undefined || typeof envelope.result !== 'string' || !HEX.test(envelope.result)) {
      return undefined;
    }
    return envelope.result.toLowerCase();
  }

  /** Token symbol and decimals read from the contract (cached per run); unreadable decimals stay `-1` (skipped). */
  async function tokenInfo(ctx: RunContext, contract: string): Promise<{ symbol: string; decimals: number }> {
    const key = `${ctx.runId}|${contract}`;
    const cached = tokenMeta.get(key);
    if (cached) return cached;
    const decimalsHex = await ethCallText(ctx, contract, DECIMALS_SELECTOR);
    const symbolHex = await ethCallText(ctx, contract, SYMBOL_SELECTOR);
    const decimals = decimalsHex && decimalsHex.length === 66 ? Number(BigInt(decimalsHex)) : -1;
    const info = { symbol: (symbolHex && decodeAbiString(symbolHex)) || '', decimals };
    tokenMeta.set(key, info);
    return info;
  }

  async function otsPage(
    ctx: RunContext,
    address: AddressRef,
    cursor: OtterscanCursor,
  ): Promise<{
    items: NormalizedTransfer[];
    skipped: { txHash: string; reason: SkipReason }[];
    next?: OtterscanCursor;
    truncated?: boolean;
  }> {
    const me = address.address.toLowerCase();
    const chain = address.chain;
    const native = nativeAsset(chain);
    const { result, fetchId } = await rpc(
      ctx,
      'ots_searchTransactionsBefore',
      [me, cursor.before, pageSize],
      'evm address history (otterscan)',
      true,
    );
    if (!isRecord(result) || !Array.isArray(result['txs']) || !Array.isArray(result['receipts'])) {
      throw new ChainProviderError('invalid_response', id, 'expected txs and receipts', { fetchId });
    }
    const txs = result['txs'] as Tx[];
    const receipts = new Map(
      (result['receipts'] as Receipt[]).map((r) => [String(r.transactionHash).toLowerCase(), r]),
    );
    const items: NormalizedTransfer[] = [];
    const skipped: { txHash: string; reason: SkipReason }[] = [];
    let lowest = Number.POSITIVE_INFINITY;
    for (const tx of txs) {
      const hash = String(tx.hash).toLowerCase();
      const height = hexToInt(tx.blockNumber);
      const receipt = receipts.get(hash);
      if (height === undefined || !receipt) {
        throw new ChainProviderError('invalid_response', id, `transaction ${hash} lacks a block or receipt`, {
          fetchId,
        });
      }
      lowest = Math.min(lowest, height);
      if (receipt.status !== undefined && hexToInt(receipt.status) === 0) continue; // reverted: value did not move
      // oxlint-disable-next-line no-await-in-loop
      const seconds = hexToInt(receipt.timestamp) ?? (await blockTime(ctx, height));
      const base = { chain, txHash: hash, blockHeight: height, blockTime: isoFromSeconds(seconds), fetchId };
      const input = typeof tx.input === 'string' ? tx.input.toLowerCase() : '0x';
      const from = tx.from.toLowerCase();
      const to = (tx.to ?? receipt.contractAddress ?? '').toLowerCase();
      const wei = hexToDecimalText(tx.value) ?? '';
      if (wei !== '' && !/^0+$/.test(wei) && (from === me || to === me)) {
        const converted = rowAmount(wei, native.decimals);
        if ('amount' in converted) {
          items.push({
            ...base,
            from,
            to,
            asset: { chain, ...native },
            amount: converted.amount,
            kind: 'native',
            ...(input.length >= 10 ? { method: input.slice(0, 10) } : {}),
          });
        } else skipped.push({ txHash: hash, reason: converted.skip });
      }
      // A plain value transfer has no inner calls: only contract calls and creations are traced.
      if (input !== '0x' || tx.to === null) {
        // Sequential on purpose: deterministic request order for cassettes.
        // oxlint-disable-next-line no-await-in-loop
        const { result: ops, fetchId: opsFetchId } = await rpc(
          ctx,
          'ots_getInternalOperations',
          [hash],
          'evm internal operations (otterscan)',
          true,
        );
        if (!Array.isArray(ops)) {
          throw new ChainProviderError('invalid_response', id, 'expected an operation list', { fetchId: opsFetchId });
        }
        (ops as InternalOp[]).forEach((op, index) => {
          const opWei = hexToDecimalText(op.value) ?? '';
          const opFrom = String(op.from).toLowerCase();
          const opTo = op.to === null ? '' : String(op.to).toLowerCase();
          if (opWei === '' || /^0+$/.test(opWei) || (opFrom !== me && opTo !== me)) return;
          // Some nodes list the top-level call as an operation: it is already the native transfer above.
          if (opFrom === from && opTo === to && opWei === wei) return;
          const converted = rowAmount(opWei, native.decimals);
          if ('amount' in converted) {
            items.push({
              ...base,
              fetchId: opsFetchId,
              index,
              from: opFrom,
              to: opTo,
              asset: { chain, ...native },
              amount: converted.amount,
              kind: 'internal',
            });
          } else skipped.push({ txHash: hash, reason: converted.skip });
        });
      }
    }
    const lastPage = result['lastPage'] === true || txs.length === 0;
    if (lastPage) return { items, skipped };
    // `before` is exclusive; a page that does not move below it would loop: report the gap instead.
    if (cursor.before > 0 && lowest >= cursor.before) return { items, skipped, truncated: true };
    return { items, skipped, next: { ...cursor, before: lowest } };
  }

  async function tokenChunk(
    ctx: RunContext,
    address: AddressRef,
    cursor: OtterscanCursor,
    head: number,
  ): Promise<{
    items: NormalizedTransfer[];
    skipped: { txHash: string; reason: SkipReason }[];
    next?: OtterscanCursor;
  }> {
    const me = address.address.toLowerCase();
    const chain = address.chain;
    const out = cursor.stage === 'tokenOut';
    const top = Math.min(cursor.before, head);
    const bottom = Math.max(0, top - logRange + 1);
    const topics = out ? [ERC20_TRANSFER_TOPIC, topicOfAddress(me)] : [ERC20_TRANSFER_TOPIC, null, topicOfAddress(me)];
    const { result, fetchId } = await rpc(
      ctx,
      'eth_getLogs',
      [{ fromBlock: quantity(bottom), toBlock: quantity(top), topics }],
      `evm erc-20 transfers ${out ? 'sent' : 'received'} (otterscan node)`,
      true,
    );
    if (!Array.isArray(result))
      throw new ChainProviderError('invalid_response', id, 'expected a log list', { fetchId });
    const items: NormalizedTransfer[] = [];
    const skipped: { txHash: string; reason: SkipReason }[] = [];
    const logs = (result as Log[]).toSorted((a, b) => (hexToInt(b.blockNumber) ?? 0) - (hexToInt(a.blockNumber) ?? 0));
    for (const log of logs) {
      // ERC-721 shares the topic (four topics, empty data): only ERC-20 (three topics, one data word) is a value transfer.
      if (log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(log.data)) continue;
      const amountText = BigInt(log.data).toString();
      if (/^0+$/.test(amountText)) continue; // zero-value transfers are address-poisoning spam
      const height = hexToInt(log.blockNumber);
      const index = hexToInt(log.logIndex);
      if (height === undefined || index === undefined) {
        throw new ChainProviderError('invalid_response', id, 'log without block or index', { fetchId });
      }
      const contract = log.address.toLowerCase();
      const hash = log.transactionHash.toLowerCase();
      // Sequential on purpose: deterministic request order for cassettes.
      // oxlint-disable-next-line no-await-in-loop
      const info = await tokenInfo(ctx, contract);
      const converted = rowAmount(amountText, info.decimals);
      if (!('amount' in converted)) {
        skipped.push({ txHash: hash, reason: converted.skip });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const seconds = hexToInt(log.blockTimestamp) ?? (await blockTime(ctx, height));
      items.push({
        chain,
        txHash: hash,
        index,
        blockHeight: height,
        ...(log.blockHash ? { blockHash: log.blockHash.toLowerCase() } : {}),
        blockTime: isoFromSeconds(seconds),
        from: addressOfTopic(log.topics[1] ?? ''),
        to: addressOfTopic(log.topics[2] ?? ''),
        // Symbols are untrusted (fake "USDT" tokens exist): the contract identifies the asset.
        asset: { chain, symbol: info.symbol, decimals: info.decimals, contract },
        amount: converted.amount,
        kind: 'token',
        fetchId,
      });
    }
    if (bottom > 0) return { items, skipped, next: { ...cursor, before: bottom - 1 } };
    const following = NEXT_STAGE[cursor.stage];
    return {
      items,
      skipped,
      ...(following ? { next: { stage: following, to: head, before: head } } : {}),
    };
  }

  return {
    id,
    chains: options.chains,

    async getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip> {
      requireChain(chain);
      await ensureReady(ctx);
      const { result } = await rpc(ctx, 'eth_blockNumber', [], 'evm chain tip', false);
      const height = hexToInt(result);
      if (height === undefined) throw new ChainProviderError('invalid_response', id, 'bad tip');
      const { result: block, fetchId } = await rpc(
        ctx,
        'eth_getBlockByNumber',
        [quantity(height), false],
        'evm chain tip block',
        false,
      );
      const seconds = isRecord(block) ? hexToInt(block['timestamp']) : undefined;
      const hash = isRecord(block) && typeof block['hash'] === 'string' ? block['hash'].toLowerCase() : '';
      if (!/^0x[0-9a-f]{64}$/.test(hash) || seconds === undefined) {
        throw new ChainProviderError('invalid_response', id, 'tip block lacks hash or timestamp', { fetchId });
      }
      timestamps.set(`${ctx.runId}|${height}`, seconds);
      return { height, hash, observedAt: ctx.clock.now().toISOString() };
    },

    async getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary> {
      requireChain(address.chain);
      await ensureReady(ctx);
      const me = address.address.toLowerCase();
      const { result: balance, fetchId } = await rpc(
        ctx,
        'eth_getBalance',
        [me, 'latest'],
        'evm address balance',
        true,
      );
      const { result: nonce } = await rpc(ctx, 'eth_getTransactionCount', [me, 'latest'], 'evm address nonce', true);
      const wei = hexToDecimalText(balance);
      const sent = hexToInt(nonce);
      if (wei === undefined || sent === undefined) {
        throw new ChainProviderError('invalid_response', id, 'bad balance or nonce', { fetchId });
      }
      // Sent transactions (nonce); the fetch runner widens the count and derives first/last seen from the history.
      return { address, txCount: sent, balance: baseUnitsToDecimal(wei, nativeAsset(address.chain).decimals), fetchId };
    },

    async listTransfers(address, listOptions, ctx): Promise<TransferPage> {
      requireChain(address.chain);
      await ensureReady(ctx);
      const cursor: OtterscanCursor = listOptions.cursor
        ? decodeCursor<OtterscanCursor>(id, listOptions.cursor)
        : {
            stage: 'ots',
            ...(listOptions.toBlock !== undefined ? { to: listOptions.toBlock } : {}),
            before: listOptions.toBlock !== undefined ? listOptions.toBlock + 1 : 0,
          };
      let page;
      let truncated = false;
      if (cursor.stage === 'ots') {
        const result = await otsPage(ctx, address, cursor);
        truncated = result.truncated === true;
        // The log stages start at the pinned tip (read now when the caller did not pin one).
        let head = cursor.to;
        let next = result.next;
        if (!next) {
          if (head === undefined) {
            const { result: tip } = await rpc(ctx, 'eth_blockNumber', [], 'evm chain tip', false);
            head = hexToInt(tip);
            if (head === undefined) throw new ChainProviderError('invalid_response', id, 'bad tip');
          }
          next = { stage: 'tokenOut', to: head, before: head };
        }
        page = { ...result, next };
      } else {
        if (cursor.to === undefined) throw new ChainProviderError('invalid_request', id, 'cursor lacks the pinned tip');
        page = await tokenChunk(ctx, address, cursor, cursor.to);
      }
      return {
        items: page.items,
        ...(page.skipped.length > 0 ? { skipped: page.skipped } : {}),
        ...(page.next ? { nextCursor: encodeCursor(id, { ...page.next }) } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    },

    async getCode(address: AddressRef, ctx: RunContext): Promise<{ code: string; fetchId: Id }> {
      requireChain(address.chain);
      await ensureReady(ctx);
      const { result, fetchId } = await rpc(
        ctx,
        'eth_getCode',
        [address.address.toLowerCase(), 'latest'],
        'evm address code (contract check)',
        true,
      );
      if (typeof result !== 'string' || !HEX.test(result)) {
        throw new ChainProviderError('invalid_response', id, 'bad code', { fetchId });
      }
      return { code: result.toLowerCase(), fetchId };
    },

    async getStorageAt(address: AddressRef, slot: string, ctx: RunContext): Promise<{ value: string; fetchId: Id }> {
      requireChain(address.chain);
      await ensureReady(ctx);
      const { result, fetchId } = await rpc(
        ctx,
        'eth_getStorageAt',
        [address.address.toLowerCase(), slot, 'latest'],
        'evm storage slot (address type probe)',
        true,
      );
      if (typeof result !== 'string' || !HEX.test(result)) {
        throw new ChainProviderError('invalid_response', id, 'bad storage word', { fetchId });
      }
      return { value: result.toLowerCase(), fetchId };
    },

    async call(address: AddressRef, data: string, ctx: RunContext): Promise<ChainCallResult> {
      requireChain(address.chain);
      await ensureReady(ctx);
      const { envelope, fetchId } = await rpcRaw(
        ctx,
        'eth_call',
        [{ to: address.address.toLowerCase(), data }, 'latest'],
        'evm contract call (address type probe)',
        true,
      );
      if (envelope.error !== undefined) return { status: 'reverted', fetchId };
      if (typeof envelope.result !== 'string' || !HEX.test(envelope.result)) {
        throw new ChainProviderError('invalid_response', id, 'bad call result', { fetchId });
      }
      return { status: 'ok', data: envelope.result.toLowerCase(), fetchId };
    },
  };
}

/** Registry adapter: `kind: otterscan` entries of `config/chain-providers.yaml` (`baseUrlEnv` overrides `baseUrl`). */
export function createOtterscanProvider(config: ChainProviderConfig, deps: ProviderDeps = {}): ChainProvider {
  const fromEnv = config.baseUrlEnv ? (deps.env ?? process.env)[config.baseUrlEnv]?.trim() : undefined;
  const number = (key: string): number | undefined => {
    const value = config.options?.[key];
    return typeof value === 'number' ? value : undefined;
  };
  const pageSize = number('pageSize');
  const minApiLevel = number('minApiLevel');
  const logBlockRange = number('logBlockRange');
  return createOtterscanEvmProvider(
    {
      id: config.id,
      chains: config.chains,
      rpcUrl: fromEnv || config.baseUrl,
      sourceId: config.sourceId,
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(minApiLevel !== undefined ? { minApiLevel } : {}),
      ...(logBlockRange !== undefined ? { logBlockRange } : {}),
    },
    deps,
  );
}
