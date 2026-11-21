/**
 * TRON over TronGrid's v1 REST API: TRC-20 transfers (USDT-TRC20, the dominant P2P/card settlement medium) with
 * fingerprint paging, and account balances. A self-hosted java-tron + TRC-20 indexer serving the same shape only
 * changes `baseUrl`. TRC-20 items carry no block number: `blockHeight` is `0` (unknown) and ordering uses
 * `blockTime`. Native TRX transfers and contract detection are not fetched yet.
 */
import type {
  AddressRef,
  AddressSummary,
  ChainId,
  ChainProvider,
  ChainTip,
  NormalizedTransfer,
  RunContext,
} from '@olcys/core';
import { apiKeyOf, type ChainProviderConfig, type ProviderDeps } from './config.ts';
import { ChainProviderError } from './errors.ts';
import { integerText, isRecord } from './json.ts';
import { CircuitBreaker, requestJson, type ChainRequest } from './request.ts';
import {
  baseUnitsToDecimal,
  contentIndex,
  decodeCursor,
  encodeCursor,
  occurrences,
  rowAmount,
  type SkipReason,
} from './units.ts';

/** Tether USD on TRON. Identify USDT by contract, never by symbol (fake "USDT" tokens exist). */
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const API_KEY_HEADER = 'TRON-PRO-API-KEY';
const PAGE_LIMIT = 200;

export interface TronCursor {
  stream: 'trc20';
  fingerprint: string;
}

interface Trc20Item {
  transaction_id: string;
  token_info?: { symbol?: string; address?: string; decimals?: number | string };
  block_timestamp: number;
  from: string;
  to: string;
  type?: string;
  value: string | number;
}

/** Pure mapping of TRC-20 list items; only `Transfer` events move value. */
export function mapTrc20Items(
  items: readonly Trc20Item[],
  fetchId: string,
  skipped: { txHash: string; reason: SkipReason }[] = [],
): NormalizedTransfer[] {
  const occurrence = occurrences();
  const out: NormalizedTransfer[] = [];
  for (const item of items) {
    if (item.type !== undefined && item.type !== 'Transfer') continue;
    const raw = item.token_info?.decimals;
    const decimals = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : -1;
    const converted = rowAmount(integerText(item.value), decimals);
    // A row that cannot be represented is skipped and reported, never fatal for the listing.
    if (!('amount' in converted)) {
      skipped.push({ txHash: item.transaction_id, reason: converted.skip });
      continue;
    }
    const value = integerText(item.value) ?? '0';
    // TRC-20 items carry no log index: a content-based index stays the same across pages and listings.
    const key = [item.transaction_id, item.token_info?.address ?? '', item.from, item.to, value].join('|');
    const index = contentIndex([key, occurrence(key)]);
    out.push({
      chain: 'tron',
      txHash: item.transaction_id,
      index,
      blockHeight: 0,
      blockTime: new Date(item.block_timestamp).toISOString(),
      from: item.from,
      to: item.to,
      asset: {
        chain: 'tron',
        symbol: item.token_info?.symbol ?? '',
        decimals,
        contract: item.token_info?.address ?? '',
      },
      amount: converted.amount,
      kind: 'token',
      fetchId,
    });
  }
  return out;
}

/** TronGrid reports some failures as HTTP 200 with `success: false`. */
const classify = (body: unknown): 'ok' | 'upstream_error' =>
  isRecord(body) && body['success'] === false ? 'upstream_error' : 'ok';

export function createTronGridProvider(config: ChainProviderConfig, deps: ProviderDeps = {}): ChainProvider {
  const breaker = new CircuitBreaker();
  const apiKey = apiKeyOf(config, deps);
  const usdtOnly = config.options?.['usdtOnly'] === true;

  const assertChain = (chain: ChainId): void => {
    if (chain !== 'tron' || !config.chains.includes(chain)) {
      throw new ChainProviderError('unsupported_chain', config.id, `${chain} is not served by this provider`);
    }
  };

  const request = (pathAndQuery: string, purpose: string, containsIdentifier: boolean): ChainRequest => ({
    providerId: config.id,
    sourceId: config.sourceId,
    url: `${config.baseUrl}${pathAndQuery}`,
    purpose,
    containsIdentifier,
    secretParams: [API_KEY_HEADER],
    ...(apiKey ? { headers: { [API_KEY_HEADER]: apiKey } } : {}),
  });

  return {
    id: config.id,
    chains: config.chains,

    async getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip> {
      assertChain(chain);
      // Solidified (irreversible) block.
      const { data, fetchId } = await requestJson<unknown>(
        ctx,
        request('/walletsolidity/getnowblock', 'tron chain tip', false),
        { breaker },
      );
      const header = isRecord(data) && isRecord(data['block_header']) ? data['block_header'] : undefined;
      const raw = header && isRecord(header['raw_data']) ? header['raw_data'] : undefined;
      const height = Number(integerText(raw?.['number']));
      if (!isRecord(data) || typeof data['blockID'] !== 'string' || !Number.isSafeInteger(height)) {
        throw new ChainProviderError('invalid_response', config.id, 'unexpected getnowblock body', { fetchId });
      }
      return { height, hash: data['blockID'], observedAt: ctx.clock.now().toISOString() };
    },

    async getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary> {
      assertChain(address.chain);
      const { data, fetchId } = await requestJson<unknown>(
        ctx,
        request(`/v1/accounts/${encodeURIComponent(address.address)}`, 'tron account balance', true),
        { breaker, classify },
      );
      const account = isRecord(data) && Array.isArray(data['data']) ? (data['data'][0] as unknown) : undefined;
      // A never-activated account has `data: []`; counts are derived from the listing by the fetch runner.
      const sun = isRecord(account) ? integerText(account['balance']) : undefined;
      return { address, txCount: 0, balance: baseUnitsToDecimal(sun ?? '0', 6), fetchId };
    },

    async listTransfers(address, options, ctx) {
      assertChain(address.chain);
      const cursor = options.cursor ? decodeCursor<TronCursor>(config.id, options.cursor) : undefined;
      const query = new URLSearchParams({
        only_confirmed: 'true',
        limit: String(PAGE_LIMIT),
        order_by: 'block_timestamp,asc',
      });
      if (usdtOnly) query.set('contract_address', USDT_TRC20);
      // With a fingerprint every other parameter must stay the same.
      if (cursor) query.set('fingerprint', cursor.fingerprint);
      const { data, fetchId } = await requestJson<unknown>(
        ctx,
        request(
          `/v1/accounts/${encodeURIComponent(address.address)}/transactions/trc20?${query.toString()}`,
          'tron TRC-20 transfer history',
          true,
        ),
        { breaker, classify },
      );
      if (!isRecord(data) || !Array.isArray(data['data'])) {
        throw new ChainProviderError('invalid_response', config.id, 'expected data[]', { fetchId });
      }
      const meta = isRecord(data['meta']) ? data['meta'] : {};
      const fingerprint = typeof meta['fingerprint'] === 'string' ? meta['fingerprint'] : undefined;
      const skipped: { txHash: string; reason: SkipReason }[] = [];
      const items = mapTrc20Items(data['data'] as Trc20Item[], fetchId, skipped);
      return {
        items,
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(fingerprint ? { nextCursor: encodeCursor(config.id, { stream: 'trc20', fingerprint }) } : {}),
      };
    },
  };
}
