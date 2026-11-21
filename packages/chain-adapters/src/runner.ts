/**
 * Fetches chain data for a plan of addresses: chain tip (once per provider and chain), summary, contract code, the
 * transfer listing (paged) and UTXO transactions, with fallback to the next provider when one is blocked, throttled
 * or failing. Requests run one after another so egress logs and cassettes stay in a deterministic order.
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
  SourceId,
  UtxoTransaction,
} from '@olcys/core';
import { chainFamily } from '@olcys/core';
import { isChainProviderError, type ChainErrorKind } from './errors.ts';
import type { ChainProviderRegistry } from './registry.ts';

export interface ChainFetchPlanItem {
  address: AddressRef;
  /** Defaults: summary and transfers always, UTXO transactions for Bitcoin, contract code for EVM. */
  want?: { summary?: boolean; transfers?: boolean; utxo?: boolean; code?: boolean };
  maxPages?: number;
}

export type ChainFetchStatus =
  | 'ok'
  | 'truncated'
  | 'unsupported'
  | 'not_found'
  | 'blocked'
  | 'rate_limited'
  | 'egress_denied'
  | 'replay_miss'
  | 'captcha'
  | 'error';

export interface ChainFetchOutcome {
  /** As planned (may be `evm:unknown`). */
  address: AddressRef;
  /** Chain actually queried. */
  chain: ChainId;
  providerId?: string;
  status: ChainFetchStatus;
  pages: number;
  items: number;
  /** Rows the provider could not represent (e.g. unsupported token decimals): skipped, the rest is kept. */
  skipped?: { txHash: string; reason: string }[];
  error?: { kind: ChainErrorKind | 'unexpected'; message: string };
}

export interface ChainFetchResult {
  tips: { chain: ChainId; providerId: string; tip: ChainTip }[];
  summaries: AddressSummary[];
  transfers: NormalizedTransfer[];
  utxoTxs: UtxoTransaction[];
  codes: { address: AddressRef; code: string; fetchId: Id }[];
  outcomes: ChainFetchOutcome[];
  /** `evm:unknown` addresses and the concrete EVM chains they were fetched on. */
  resolved: { requested: AddressRef; resolved: AddressRef }[];
}

/** One tip per (provider, chain), shared across fetch passes of a run; a failed tip is remembered as missing. */
export class TipCache {
  private readonly tips = new Map<string, Promise<ChainTip | undefined>>();
  readonly errors: { providerId: string; chain: ChainId; message: string }[] = [];

  get(provider: ChainProvider, chain: ChainId, ctx: RunContext): Promise<ChainTip | undefined> {
    const key = `${provider.id}|${chain}`;
    let tip = this.tips.get(key);
    if (!tip) {
      tip = provider.getTip(chain, ctx).catch((error: unknown) => {
        if (!isChainProviderError(error)) throw error;
        this.errors.push({ providerId: provider.id, chain, message: error.message });
        return undefined;
      });
      this.tips.set(key, tip);
    }
    return tip;
  }
}

export interface ChainFetchOptions {
  /** Sources enabled for the case (AMBER providers need the analyst's justification). */
  enabledSources: readonly SourceId[];
  /** Page limit per address and listing (default 40); hitting it marks the outcome `truncated`. */
  defaultMaxPages?: number;
  /** Chains probed for `evm:unknown` addresses (default `evm:1`). */
  unknownEvmChains?: readonly ChainId[];
  tips?: TipCache;
}

/** Errors after which the address is retried on the next provider (cursors are provider-specific). */
const FALLBACK_KINDS: ReadonlySet<ChainErrorKind> = new Set<ChainErrorKind>([
  'blocked',
  'captcha',
  'rate_limited',
  'upstream_error',
]);
const KIND_ORDER: Record<NormalizedTransfer['kind'], number> = { native: 0, internal: 1, token: 2 };
/** Errors that end a listing early but keep what was read (`truncated` outcome). */
const TRUNCATING_KINDS: ReadonlySet<ChainErrorKind> = new Set<ChainErrorKind>(['window_exceeded', 'budget_exceeded']);

function statusOf(kind: ChainErrorKind): ChainFetchStatus {
  switch (kind) {
    case 'not_found':
    case 'blocked':
    case 'rate_limited':
    case 'egress_denied':
    case 'replay_miss':
    case 'captcha':
      return kind;
    case 'unsupported_chain':
    case 'unsupported_operation':
    case 'plan_restricted':
      return 'unsupported';
    default:
      return 'error';
  }
}

export function transferKey(t: NormalizedTransfer): string {
  return [t.chain, t.txHash, t.kind, t.index ?? '', t.from, t.to, t.asset.contract ?? t.asset.symbol].join('|');
}

export function compareTransfers(a: NormalizedTransfer, b: NormalizedTransfer): number {
  if (a.blockTime !== b.blockTime) return a.blockTime < b.blockTime ? -1 : 1;
  if (a.blockHeight !== b.blockHeight) return a.blockHeight - b.blockHeight;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.index ?? 0) - (b.index ?? 0);
}

const sameAddress = (chain: ChainId, a: string, b: string): boolean =>
  chainFamily(chain) === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

interface Fetched {
  summary?: AddressSummary;
  code?: { code: string; fetchId: Id };
  transfers: NormalizedTransfer[];
  utxoTxs: UtxoTransaction[];
  pages: number;
  truncated: boolean;
  skipped: { txHash: string; reason: string }[];
}

async function fetchFrom(
  provider: ChainProvider,
  address: AddressRef,
  want: Required<NonNullable<ChainFetchPlanItem['want']>>,
  maxPages: number,
  tip: ChainTip | undefined,
  ctx: RunContext,
): Promise<Fetched> {
  const fetched: Fetched = { transfers: [], utxoTxs: [], pages: 0, truncated: false, skipped: [] };
  if (want.summary) fetched.summary = await provider.getAddressSummary(address, ctx);
  if (want.code && provider.getCode) fetched.code = await provider.getCode(address, ctx);
  if (want.transfers) {
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) {
        fetched.truncated = true;
        break;
      }
      const options = { ...(cursor ? { cursor } : {}), ...(tip ? { toBlock: tip.height } : {}) };
      // Sequential on purpose: each page needs the previous cursor.
      let result;
      try {
        // oxlint-disable-next-line no-await-in-loop
        result = await provider.listTransfers(address, options, ctx);
      } catch (error) {
        // A listing that cannot go further keeps the pages already read.
        if (isChainProviderError(error) && TRUNCATING_KINDS.has(error.kind)) {
          fetched.truncated = true;
          break;
        }
        throw error;
      }
      fetched.pages += 1;
      fetched.transfers.push(...result.items);
      if (result.truncated) fetched.truncated = true;
      if (result.skipped) fetched.skipped.push(...result.skipped);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }
  if (want.utxo && provider.listUtxoTransactions) {
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) {
        fetched.truncated = true;
        break;
      }
      // oxlint-disable-next-line no-await-in-loop
      const result = await provider.listUtxoTransactions(address, cursor ? { cursor } : {}, ctx);
      fetched.utxoTxs.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }
  return fetched;
}

export async function runChainFetch(
  plan: readonly ChainFetchPlanItem[],
  registry: ChainProviderRegistry,
  ctx: RunContext,
  options: ChainFetchOptions,
): Promise<ChainFetchResult> {
  const tips = options.tips ?? new TipCache();
  const result: ChainFetchResult = {
    tips: [],
    summaries: [],
    transfers: [],
    utxoTxs: [],
    codes: [],
    outcomes: [],
    resolved: [],
  };
  const seenTransfers = new Set<string>();
  const seenUtxo = new Set<string>();
  const tipSeen = new Set<string>();

  for (const item of plan) {
    const chains =
      item.address.chain === 'evm:unknown' ? (options.unknownEvmChains ?? ['evm:1']) : [item.address.chain];
    const family = chainFamily(item.address.chain);
    const want = {
      summary: item.want?.summary ?? true,
      transfers: item.want?.transfers ?? true,
      utxo: item.want?.utxo ?? family === 'bitcoin',
      code: item.want?.code ?? family === 'evm',
    };
    for (const chain of chains) {
      const address: AddressRef = {
        chain,
        address: chainFamily(chain) === 'evm' ? item.address.address.toLowerCase() : item.address.address,
      };
      const providers = registry.forChain(chain, options.enabledSources);
      if (providers.length === 0) {
        result.outcomes.push({ address: item.address, chain, status: 'unsupported', pages: 0, items: 0 });
        continue;
      }
      for (const provider of providers) {
        // Sequential on purpose: one provider at a time, fallback only after a failure.
        // oxlint-disable-next-line no-await-in-loop
        const tip = await tips.get(provider, chain, ctx);
        if (tip && !tipSeen.has(`${provider.id}|${chain}`)) {
          tipSeen.add(`${provider.id}|${chain}`);
          result.tips.push({ chain, providerId: provider.id, tip });
        }
        let fetched: Fetched;
        try {
          // oxlint-disable-next-line no-await-in-loop
          fetched = await fetchFrom(provider, address, want, item.maxPages ?? options.defaultMaxPages ?? 40, tip, ctx);
        } catch (error) {
          if (!isChainProviderError(error)) throw error;
          result.outcomes.push({
            address: item.address,
            chain,
            providerId: provider.id,
            status: statusOf(error.kind),
            pages: 0,
            items: 0,
            error: { kind: error.kind, message: error.message },
          });
          if (FALLBACK_KINDS.has(error.kind)) continue;
          break;
        }

        // The state is the recorded tip: later blocks are not part of this snapshot.
        const transfers = fetched.transfers.filter((t) => !(tip && t.blockHeight > tip.height));
        const utxoTxs = fetched.utxoTxs.filter((t) => !(tip && (t.blockHeight ?? 0) > tip.height));
        let kept = 0;
        for (const transfer of transfers) {
          const key = transferKey(transfer);
          if (seenTransfers.has(key)) continue;
          seenTransfers.add(key);
          result.transfers.push(transfer);
          kept += 1;
        }
        for (const tx of utxoTxs) {
          if (seenUtxo.has(`${tx.chain}|${tx.txid}`)) continue;
          seenUtxo.add(`${tx.chain}|${tx.txid}`);
          result.utxoTxs.push(tx);
          kept += 1;
        }
        if (fetched.code) result.codes.push({ address, ...fetched.code });
        if (fetched.summary) {
          result.summaries.push(
            deriveSummary(fetched.summary, address, transfers, utxoTxs, fetched.truncated || !want.transfers),
          );
        }
        if (item.address.chain === 'evm:unknown') result.resolved.push({ requested: item.address, resolved: address });
        result.outcomes.push({
          address: item.address,
          chain,
          providerId: provider.id,
          status: fetched.truncated ? 'truncated' : 'ok',
          pages: fetched.pages,
          items: kept,
          ...(fetched.skipped.length > 0 ? { skipped: fetched.skipped } : {}),
        });
        break;
      }
    }
  }
  result.transfers.sort(compareTransfers);
  return result;
}

/** First/last activity and transaction count from the listing when it is complete; otherwise the provider's. */
function deriveSummary(
  summary: AddressSummary,
  address: AddressRef,
  transfers: readonly NormalizedTransfer[],
  utxoTxs: readonly UtxoTransaction[],
  partial: boolean,
): AddressSummary {
  if (partial) return summary;
  const mine = transfers.filter(
    (t) => sameAddress(address.chain, t.from, address.address) || sameAddress(address.chain, t.to, address.address),
  );
  const times = [...mine.map((t) => t.blockTime), ...utxoTxs.map((t) => t.blockTime ?? '')]
    .filter((t) => t !== '')
    .toSorted();
  const txIds = new Set([...mine.map((t) => t.txHash), ...utxoTxs.map((t) => t.txid)]);
  const derived: AddressSummary = { ...summary, txCount: Math.max(summary.txCount, txIds.size) };
  if (times.length > 0) {
    derived.firstSeen = times[0] ?? '';
    derived.lastSeen = times.at(-1) ?? '';
  }
  return derived;
}
