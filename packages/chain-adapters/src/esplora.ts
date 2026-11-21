/**
 * Bitcoin over the Esplora REST API shared by mempool.space, blockstream.info and a self-hosted electrs/Esplora
 * backend: only `baseUrl` differs. Endpoints: `/blocks/tip/height`, `/address/{a}`, `/address/{a}/txs` (first page:
 * mempool txs + the 25 newest confirmed) and `/address/{a}/txs/chain/{lastSeenTxid}` (next 25 confirmed).
 * Unconfirmed transactions are never evidence and are skipped.
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
  UtxoTransaction,
} from '@olcys/core';
import { dSub } from '@olcys/core';
import type { ChainProviderConfig, ProviderDeps } from './config.ts';
import { ChainProviderError } from './errors.ts';
import { integerText, isRecord } from './json.ts';
import { CircuitBreaker, requestJson, requestText, type ChainRequest } from './request.ts';
import { baseUnitsToDecimal, decodeCursor, encodeCursor, isoFromSeconds } from './units.ts';

/** Esplora serves confirmed history in pages of 25 (fixed; `limit` is ignored). */
export const ESPLORA_PAGE_SIZE = 25;

export interface EsploraVin {
  txid?: string;
  vout?: number;
  is_coinbase?: boolean;
  prevout?: { scriptpubkey_address?: string; scriptpubkey_type?: string; value: number | string } | null;
}

export interface EsploraVout {
  scriptpubkey_address?: string;
  scriptpubkey_type?: string;
  value: number | string;
}

export interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number | string;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

const sats = (value: unknown): string => {
  const text = integerText(value);
  if (text === undefined) throw new TypeError(`invalid satoshi value ${String(value)}`);
  return baseUnitsToDecimal(text, 8);
};

/** Pure mapping of a confirmed Esplora transaction. */
export function mapEsploraTx(tx: EsploraTx, chain: ChainId, fetchId: Id): UtxoTransaction {
  const mapped: UtxoTransaction = {
    chain,
    txid: tx.txid,
    inputs: tx.vin.map((vin) => {
      if (vin.is_coinbase || !vin.prevout) return { value: '0', prevTxid: vin.txid ?? '', vout: vin.vout ?? 0 };
      return {
        ...(vin.prevout.scriptpubkey_address ? { address: vin.prevout.scriptpubkey_address } : {}),
        value: sats(vin.prevout.value),
        prevTxid: vin.txid ?? '',
        vout: vin.vout ?? 0,
      };
    }),
    outputs: tx.vout.map((out, n) => ({
      ...(out.scriptpubkey_address ? { address: out.scriptpubkey_address } : {}),
      value: sats(out.value),
      n,
      ...(out.scriptpubkey_type ? { scriptType: out.scriptpubkey_type } : {}),
    })),
    fetchId,
  };
  if (tx.status.block_height !== undefined) mapped.blockHeight = tx.status.block_height;
  if (tx.status.block_time !== undefined) mapped.blockTime = isoFromSeconds(tx.status.block_time);
  if (tx.fee !== undefined) mapped.fee = sats(tx.fee);
  return mapped;
}

/**
 * Account-style view of a UTXO transaction for counterparty and cash-out rules (volumes use the UTXO data).
 * Spending tx: one transfer per output to another address (change and address-less outputs are not transfers).
 * Receiving tx: one transfer per output to the address, `from` = the largest-value input (tie → lowest index).
 */
export function deriveTransfers(tx: UtxoTransaction, address: string, blockHash?: string): NormalizedTransfer[] {
  const transfer = (index: number, from: string, to: string, amount: string): NormalizedTransfer => {
    const t: NormalizedTransfer = {
      chain: tx.chain,
      txHash: tx.txid,
      index,
      blockHeight: tx.blockHeight ?? 0,
      blockTime: tx.blockTime ?? '',
      from,
      to,
      asset: { chain: tx.chain, symbol: 'BTC', decimals: 8 },
      amount,
      kind: 'native',
      fetchId: tx.fetchId,
    };
    if (blockHash) t.blockHash = blockHash;
    return t;
  };
  // One representation per (txid, output), whichever address's history it is read from, so merged histories
  // de-duplicate: the sender is the first input with an address in transaction input order.
  const sender = tx.inputs.find((input) => input.address !== undefined)?.address ?? 'coinbase';
  const spends = tx.inputs.some((input) => input.address === address);
  return tx.outputs
    .filter((out) => out.address !== undefined && (spends ? out.address !== address : out.address === address))
    .map((out) => transfer(out.n, sender, out.address ?? '', out.value));
}

interface RawPage {
  txs: EsploraTx[];
  fetchId: Id;
}

export function createEsploraProvider(config: ChainProviderConfig, _deps: ProviderDeps = {}): ChainProvider {
  const breaker = new CircuitBreaker();
  // Per-run memo: listTransfers and listUtxoTransactions over the same cursor cost one request.
  const pages = new Map<string, Promise<RawPage>>();

  const request = (path: string, purpose: string, containsIdentifier: boolean): ChainRequest => ({
    providerId: config.id,
    sourceId: config.sourceId,
    url: `${config.baseUrl}${path}`,
    purpose,
    containsIdentifier,
  });

  const assertChain = (chain: ChainId): void => {
    if (!config.chains.includes(chain)) {
      throw new ChainProviderError('unsupported_chain', config.id, `${chain} is not served by this provider`);
    }
  };

  function loadPage(address: AddressRef, cursor: string | undefined, ctx: RunContext): Promise<RawPage> {
    assertChain(address.chain);
    const key = `${ctx.runId}|${address.address}|${cursor ?? ''}`;
    let page = pages.get(key);
    if (!page) {
      const state = cursor ? decodeCursor<{ lastSeenTxid: string }>(config.id, cursor) : undefined;
      const path = state
        ? `/address/${encodeURIComponent(address.address)}/txs/chain/${encodeURIComponent(state.lastSeenTxid)}`
        : `/address/${encodeURIComponent(address.address)}/txs`;
      page = requestJson<unknown>(ctx, request(path, 'bitcoin address transaction history', true), {
        breaker,
      }).then(({ data, fetchId }) => {
        if (!Array.isArray(data)) {
          throw new ChainProviderError('invalid_response', config.id, 'expected a transaction list', { fetchId });
        }
        return { txs: data as EsploraTx[], fetchId };
      });
      page.catch(() => pages.delete(key));
      pages.set(key, page);
    }
    return page;
  }

  function confirmedPage(page: RawPage): { txs: EsploraTx[]; nextCursor?: string } {
    const confirmed = page.txs.filter((tx) => tx.status?.confirmed === true);
    const last = confirmed.at(-1);
    return confirmed.length >= ESPLORA_PAGE_SIZE && last
      ? { txs: confirmed, nextCursor: encodeCursor(config.id, { lastSeenTxid: last.txid }) }
      : { txs: confirmed };
  }

  return {
    id: config.id,
    chains: config.chains,

    async getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip> {
      assertChain(chain);
      const { text } = await requestText(ctx, request('/blocks/tip/height', 'bitcoin chain tip', false), {
        breaker,
      });
      const height = Number(text);
      if (!Number.isSafeInteger(height) || height < 0) {
        throw new ChainProviderError('invalid_response', config.id, `tip height ${JSON.stringify(text)}`);
      }
      // The tip hash would cost a second request; the recorded height dates the snapshot.
      return { height, hash: '', observedAt: ctx.clock.now().toISOString() };
    },

    async getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary> {
      assertChain(address.chain);
      const { data, fetchId } = await requestJson<unknown>(
        ctx,
        request(`/address/${encodeURIComponent(address.address)}`, 'bitcoin address summary', true),
        { breaker },
      );
      const stats = isRecord(data) && isRecord(data['chain_stats']) ? data['chain_stats'] : undefined;
      if (!stats) throw new ChainProviderError('invalid_response', config.id, 'missing chain_stats', { fetchId });
      const received = sats(stats['funded_txo_sum']);
      const sent = sats(stats['spent_txo_sum']);
      return {
        address,
        txCount: Number(integerText(stats['tx_count']) ?? 0),
        totalReceived: received,
        totalSent: sent,
        balance: dSub(received, sent),
        fetchId,
      };
    },

    async listUtxoTransactions(address, options, ctx) {
      const raw = await loadPage(address, options.cursor, ctx);
      const page = confirmedPage(raw);
      return {
        items: page.txs.map((tx) => mapEsploraTx(tx, address.chain, raw.fetchId)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    async listTransfers(address, options, ctx) {
      const raw = await loadPage(address, options.cursor, ctx);
      const page = confirmedPage(raw);
      const items = page.txs.flatMap((tx) =>
        deriveTransfers(mapEsploraTx(tx, address.chain, raw.fetchId), address.address, tx.status.block_hash),
      );
      return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  };
}
