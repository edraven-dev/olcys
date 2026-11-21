/**
 * EVM chains over the Etherscan-compatible `module/action` API (Etherscan V2: one key + `chainid`). A self-hosted
 * Etherscan-compatible backend only changes `baseUrl`. Listing streams native (`txlist`), internal
 * (`txlistinternal`) and ERC-20 (`tokentx`) transfers in ascending block order; list endpoints stop at 10 000 rows
 * per window, so a full 10th page opens a new window at the last block. Terms: "Powered by Etherscan.io APIs" must
 * be shown with the data; free plans are for personal and research use (prototype only).
 */
import type {
  AddressRef,
  AddressSummary,
  ChainId,
  ChainProvider,
  ChainTip,
  Id,
  NormalizedTransfer,
  RunContext,
} from '@olcys/core';
import { KNOWN_CHAINS } from '@olcys/core';
import { apiKeyOf, type ChainProviderConfig, type ProviderDeps } from './config.ts';
import { ChainProviderError, type ChainErrorKind } from './errors.ts';
import { isRecord } from './json.ts';
import { CircuitBreaker, requestJson, type ChainRequest } from './request.ts';
import { baseUnitsToDecimal, decodeCursor, encodeCursor, isoFromSeconds } from './units.ts';

export const ETHERSCAN_ATTRIBUTION = 'Powered by Etherscan.io APIs';
const STREAMS = ['normal', 'internal', 'token'] as const;
type Stream = (typeof STREAMS)[number];
const ACTION: Record<Stream, string> = { normal: 'txlist', internal: 'txlistinternal', token: 'tokentx' };
const MAX_WINDOW_ROWS = 10_000;
const OPEN_END_BLOCK = 999_999_999;

export interface EtherscanCursor {
  stream: Stream;
  startBlock: number;
  endBlock: number;
  page: number;
}

/** Body-level verdict for an Etherscan response (status `0` bodies arrive with HTTP 200). */
export function classifyEtherscan(body: unknown): 'ok' | ChainErrorKind {
  if (!isRecord(body)) return 'invalid_response';
  if ('jsonrpc' in body) {
    if (body['error'] !== undefined) return 'upstream_error';
    return typeof body['result'] === 'string' ? 'ok' : 'invalid_response';
  }
  if (body['status'] === '1') return 'ok';
  const message = String(body['message'] ?? '');
  const result = typeof body['result'] === 'string' ? body['result'] : '';
  if (/^no (transactions|records) found/i.test(message) && Array.isArray(body['result'])) return 'ok';
  const text = `${message} ${result}`.toLowerCase();
  if (text.includes('rate limit') || text.includes('community free api limit')) return 'rate_limited';
  if (text.includes('invalid api key') || text.includes('missing/invalid') || text.includes('missing api key')) {
    return 'auth_error';
  }
  if (text.includes('not supported for this chain') || text.includes('free api access')) return 'plan_restricted';
  if (text.includes('result window is too large')) return 'window_exceeded';
  if (text.includes('invalid address') || text.includes('invalid parameter')) return 'invalid_request';
  return 'upstream_error';
}

interface Row {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  blockHash?: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
  txreceipt_status?: string;
  contractAddress?: string;
  methodId?: string;
  functionName?: string;
  logIndex?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

function nativeAsset(chain: ChainId): { symbol: string; decimals: number } {
  const info = KNOWN_CHAINS.find((c) => c.id === chain);
  return { symbol: info?.nativeAsset ?? 'ETH', decimals: info?.decimals ?? 18 };
}

function methodOf(row: Row): string | undefined {
  if (row.functionName) return row.functionName.split('(')[0]?.trim() || undefined;
  return row.methodId && row.methodId !== '0x' ? row.methodId : undefined;
}

/** Maps one page of rows of a stream; failed and zero-value token/internal rows are dropped. */
export function mapEtherscanRows(
  stream: Stream,
  rows: readonly Row[],
  chain: ChainId,
  fetchId: Id,
): NormalizedTransfer[] {
  const native = nativeAsset(chain);
  const ordinal = new Map<string, number>();
  const nextOrdinal = (hash: string): number => {
    const n = ordinal.get(hash) ?? 0;
    ordinal.set(hash, n + 1);
    return n;
  };
  const out: NormalizedTransfer[] = [];
  for (const row of rows) {
    const base = {
      chain,
      txHash: row.hash.toLowerCase(),
      blockHeight: Number(row.blockNumber),
      blockTime: isoFromSeconds(Number(row.timeStamp)),
      from: row.from.toLowerCase(),
      fetchId,
      ...(row.blockHash ? { blockHash: row.blockHash.toLowerCase() } : {}),
    };
    if (stream === 'normal') {
      if (row.isError === '1' || row.txreceipt_status === '0') continue; // value did not move
      const method = methodOf(row);
      out.push({
        ...base,
        to: (row.to || row.contractAddress || '').toLowerCase(),
        asset: { chain, ...native },
        amount: baseUnitsToDecimal(row.value, native.decimals),
        kind: 'native',
        ...(method ? { method } : {}),
      });
    } else if (stream === 'internal') {
      const index = nextOrdinal(base.txHash);
      if (row.isError === '1' || /^0+$/.test(row.value)) continue;
      out.push({
        ...base,
        index,
        to: (row.to || row.contractAddress || '').toLowerCase(),
        asset: { chain, ...native },
        amount: baseUnitsToDecimal(row.value, native.decimals),
        kind: 'internal',
      });
    } else {
      const index =
        row.logIndex !== undefined && /^\d+$/.test(row.logIndex) ? Number(row.logIndex) : nextOrdinal(base.txHash);
      const decimals = Number(row.tokenDecimal);
      // Zero-value token transfers are address-poisoning spam; a token without decimals cannot be valued.
      if (/^0+$/.test(row.value) || !Number.isInteger(decimals)) continue;
      out.push({
        ...base,
        index,
        to: row.to.toLowerCase(),
        // Symbols are untrusted (fake "USDT" tokens exist): the contract identifies the asset.
        asset: { chain, symbol: row.tokenSymbol ?? '', decimals, contract: (row.contractAddress ?? '').toLowerCase() },
        amount: baseUnitsToDecimal(row.value, decimals),
        kind: 'token',
      });
    }
  }
  return out;
}

export function createEtherscanProvider(config: ChainProviderConfig, deps: ProviderDeps = {}): ChainProvider {
  const breaker = new CircuitBreaker();
  const apiKey = apiKeyOf(config, deps);
  const pageSize = Math.min(Number(config.options?.['pageSize'] ?? 1000), 1000);
  // List endpoints refuse page × offset > 10 000 ("Result window is too large").
  const windowRows = Number(config.options?.['windowRows'] ?? MAX_WINDOW_ROWS);
  const sleep = deps.sleep;

  const chainIdOf = (chain: ChainId): string => {
    if (!config.chains.includes(chain) || !/^evm:\d+$/.test(chain)) {
      throw new ChainProviderError('unsupported_chain', config.id, `${chain} is not configured for this provider`);
    }
    return chain.slice(4);
  };

  function call(
    chain: ChainId,
    params: Record<string, string>,
    purpose: string,
    containsIdentifier: boolean,
  ): ChainRequest {
    const query = new URLSearchParams({ chainid: chainIdOf(chain), ...params });
    if (apiKey) query.set('apikey', apiKey);
    return {
      providerId: config.id,
      sourceId: config.sourceId,
      url: `${config.baseUrl}?${query.toString()}`,
      purpose,
      containsIdentifier,
      secretParams: ['apikey'],
    };
  }

  async function rpcResult(
    ctx: RunContext,
    chain: ChainId,
    params: Record<string, string>,
    purpose: string,
    identifying: boolean,
  ): Promise<{ result: string; fetchId: Id }> {
    const { data, fetchId } = await requestJson<{ result: string }>(
      ctx,
      call(chain, { module: 'proxy', ...params }, purpose, identifying),
      { classify: classifyEtherscan, breaker, ...(sleep ? { sleep } : {}) },
    );
    return { result: data.result, fetchId };
  }

  return {
    id: config.id,
    chains: config.chains,

    async getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip> {
      const { result } = await rpcResult(ctx, chain, { action: 'eth_blockNumber' }, 'evm chain tip', false);
      const height = Number.parseInt(result, 16);
      if (!Number.isSafeInteger(height)) throw new ChainProviderError('invalid_response', config.id, 'bad tip');
      // The block hash would cost a second request; the recorded height dates every state read.
      return { height, hash: '', observedAt: ctx.clock.now().toISOString() };
    },

    async getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary> {
      const params = { module: 'account', action: 'balance', address: address.address, tag: 'latest' };
      const { data, fetchId } = await requestJson<{ result: string }>(
        ctx,
        call(address.chain, params, 'evm address balance', true),
        { classify: classifyEtherscan, breaker, ...(sleep ? { sleep } : {}) },
      );
      // The transaction count is derived from the listing by the fetch runner.
      return {
        address,
        txCount: 0,
        balance: baseUnitsToDecimal(data.result, nativeAsset(address.chain).decimals),
        fetchId,
      };
    },

    async listTransfers(address, options, ctx) {
      const cursor = options.cursor
        ? decodeCursor<EtherscanCursor>(config.id, options.cursor)
        : {
            stream: 'normal' as Stream,
            startBlock: options.fromBlock ?? 0,
            endBlock: options.toBlock ?? OPEN_END_BLOCK,
            page: 1,
          };
      const params = {
        module: 'account',
        action: ACTION[cursor.stream],
        address: address.address,
        startblock: String(cursor.startBlock),
        endblock: String(cursor.endBlock),
        page: String(cursor.page),
        offset: String(pageSize),
        sort: 'asc',
      };
      const { data, fetchId } = await requestJson<{ result: unknown }>(
        ctx,
        call(address.chain, params, `evm ${ACTION[cursor.stream]} history`, true),
        { classify: classifyEtherscan, breaker, ...(sleep ? { sleep } : {}) },
      );
      if (!Array.isArray(data.result)) {
        throw new ChainProviderError('invalid_response', config.id, 'expected a row list', { fetchId });
      }
      let rows = data.result as Row[];
      let next: EtherscanCursor | undefined;
      if (rows.length >= pageSize) {
        if (cursor.page * pageSize >= windowRows) {
          // Window full: restart at the last block and re-read that block whole in the new window.
          const lastBlock = Number(rows.at(-1)?.blockNumber);
          if (rows.every((row) => Number(row.blockNumber) === lastBlock) || lastBlock <= cursor.startBlock) {
            throw new ChainProviderError('window_exceeded', config.id, `block ${lastBlock} fills a whole window`, {
              fetchId,
            });
          }
          rows = rows.filter((row) => Number(row.blockNumber) !== lastBlock);
          next = { ...cursor, startBlock: lastBlock, page: 1 };
        } else {
          next = { ...cursor, page: cursor.page + 1 };
        }
      } else {
        const following = STREAMS[STREAMS.indexOf(cursor.stream) + 1];
        if (following) {
          next = { stream: following, startBlock: options.fromBlock ?? 0, endBlock: cursor.endBlock, page: 1 };
        }
      }
      const items = mapEtherscanRows(cursor.stream, rows, address.chain, fetchId);
      return { items, ...(next ? { nextCursor: encodeCursor(config.id, { ...next }) } : {}) };
    },

    async getCode(address: AddressRef, ctx: RunContext): Promise<{ code: string; fetchId: Id }> {
      const { result, fetchId } = await rpcResult(
        ctx,
        address.chain,
        { action: 'eth_getCode', address: address.address, tag: 'latest' },
        'evm address code (contract check)',
        true,
      );
      return { code: result.toLowerCase(), fetchId };
    },
  };
}
