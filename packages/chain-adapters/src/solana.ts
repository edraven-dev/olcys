/**
 * Solana over standard JSON-RPC (`getSlot`, `getBlock`, `getBalance`, `getSignaturesForAddress`, `getTransaction`
 * with `jsonParsed`): SOL transfers of the system program and SPL-token transfers (also inner/CPI instructions),
 * turned into owner-level transfers of the queried address. Solana identifies blocks by slot (`blockHeight` carries
 * the slot) and tokens by mint (never by symbol). The public endpoint is "not for production"; a self-hosted node
 * only changes `baseUrl`. Every call is a POST with a deterministic body (`id` 1, fixed key order) so cassette keys
 * are stable; all traffic goes through `ctx.http`.
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
  TransferPage,
} from '@olcys/core';
import type { ChainProviderConfig, ProviderDeps } from './config.ts';
import { ChainProviderError, type ChainErrorKind } from './errors.ts';
import { integerText, isRecord } from './json.ts';
import { CircuitBreaker, requestJson } from './request.ts';
import { baseUnitsToDecimal, decodeCursor, encodeCursor, isoFromSeconds, rowAmount } from './units.ts';

export const SOLANA_SIGNATURE_PAGE = 1000;
export const SOLANA_MAX_TRANSACTIONS = 500;
const SKIPPED_SLOT_CODES = new Set([-32007, -32009]);
const MAX_TIP_STEPS = 10;

/** Well-known SPL mints; verify against the issuers' pages before relying on a symbol. */
export const KNOWN_SPL_MINTS: Readonly<Record<string, { symbol: string; decimals: number }>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { symbol: 'EURC', decimals: 6 },
};

export interface SolanaCursor {
  before?: string;
  until?: string;
  /** Transactions already read for this address (budget). */
  read?: number;
}

interface SolanaInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface TokenBalance {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { decimals?: number };
}
export interface SolanaParsedTx {
  slot?: number;
  blockTime?: number | null;
  transaction: {
    message: { accountKeys: (string | { pubkey?: string })[]; instructions: SolanaInstruction[] };
    signatures?: string[];
  };
  meta?: {
    err?: unknown;
    innerInstructions?: { index: number; instructions: SolanaInstruction[] }[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Pure: transfers of `address` in one `jsonParsed` transaction; `signature`, `slot` and `blockTime` come from the listing. */
export function parseSolanaTransfers(
  tx: SolanaParsedTx,
  address: string,
  fetchId: Id,
  entry: { signature: string; slot: number; blockTime: number },
  skipped: { txHash: string; reason: 'unsupported_decimals' | 'invalid_amount' }[] = [],
): NormalizedTransfer[] {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : (k.pubkey ?? '')));
  // Token account → owner, mint and decimals, from the balances the transaction reports.
  const tokenAccounts = new Map<string, { owner?: string; mint?: string; decimals?: number }>();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const account = keys[b.accountIndex];
    if (!account) continue;
    tokenAccounts.set(account, {
      ...(b.owner ? { owner: b.owner } : {}),
      ...(b.mint ? { mint: b.mint } : {}),
      ...(typeof b.uiTokenAmount?.decimals === 'number' ? { decimals: b.uiTokenAmount.decimals } : {}),
    });
  }
  const out: NormalizedTransfer[] = [];
  const base = { chain: 'solana' as ChainId, txHash: entry.signature, blockHeight: entry.slot, fetchId };
  const blockTime = isoFromSeconds(entry.blockTime);
  const visit = (ins: SolanaInstruction, index: number): void => {
    const type = ins.parsed?.type;
    const info = ins.parsed?.info;
    if (!info || !type) return;
    if (ins.program === 'system' && (type === 'transfer' || type === 'transferWithSeed')) {
      const from = text(info['source']);
      const to = text(info['destination']);
      const lamports = integerText(info['lamports']);
      if (!from || !to || lamports === undefined || (from !== address && to !== address)) return;
      out.push({
        ...base,
        index,
        blockTime,
        from,
        to,
        asset: { chain: 'solana', symbol: 'SOL', decimals: 9 },
        amount: baseUnitsToDecimal(lamports, 9),
        kind: 'native',
      });
      return;
    }
    if (
      (ins.program === 'spl-token' || ins.program === 'spl-token-2022') &&
      (type === 'transfer' || type === 'transferChecked')
    ) {
      const source = text(info['source']);
      const destination = text(info['destination']);
      if (!source || !destination) return;
      const from = tokenAccounts.get(source)?.owner ?? source;
      const to = tokenAccounts.get(destination)?.owner ?? destination;
      if (from !== address && to !== address) return;
      const checked = isRecord(info['tokenAmount']) ? info['tokenAmount'] : undefined;
      const raw = integerText(checked?.['amount']) ?? integerText(info['amount']);
      const mint = text(info['mint']) ?? tokenAccounts.get(source)?.mint ?? tokenAccounts.get(destination)?.mint;
      const decimals =
        typeof checked?.['decimals'] === 'number'
          ? checked['decimals']
          : (tokenAccounts.get(source)?.decimals ?? tokenAccounts.get(destination)?.decimals ?? -1);
      const converted = rowAmount(raw, decimals);
      if (!('amount' in converted)) {
        skipped.push({ txHash: entry.signature, reason: converted.skip });
        return;
      }
      out.push({
        ...base,
        index,
        blockTime,
        from,
        to,
        asset: {
          chain: 'solana',
          symbol: (mint ? KNOWN_SPL_MINTS[mint]?.symbol : undefined) ?? 'SPL',
          decimals,
          ...(mint ? { contract: mint } : {}),
        },
        amount: converted.amount,
        kind: 'token',
      });
    }
  };
  tx.transaction.message.instructions.forEach((ins, i) => visit(ins, i * 100));
  for (const inner of tx.meta?.innerInstructions ?? []) {
    inner.instructions.forEach((ins, j) => visit(ins, inner.index * 100 + j + 1));
  }
  return out;
}

/** JSON-RPC errors: throttling retries, other errors fail; a skipped slot is an answer the tip logic handles. */
function classify(body: unknown): 'ok' | ChainErrorKind {
  if (!isRecord(body)) return 'invalid_response';
  const error = body['error'];
  if (error === undefined) return 'ok';
  const code = isRecord(error) ? error['code'] : undefined;
  if (typeof code === 'number' && SKIPPED_SLOT_CODES.has(code)) return 'ok';
  return code === -32005 ? 'rate_limited' : 'upstream_error';
}

export function createSolanaRpcProvider(config: ChainProviderConfig, deps: ProviderDeps = {}): ChainProvider {
  const breaker = new CircuitBreaker();
  const maxTransactions = Number(config.options?.['maxTransactions'] ?? SOLANA_MAX_TRANSACTIONS);
  const pageSize = Number(config.options?.['pageSize'] ?? SOLANA_SIGNATURE_PAGE);

  const assertChain = (chain: ChainId): void => {
    if (chain !== 'solana' || !config.chains.includes(chain)) {
      throw new ChainProviderError('unsupported_chain', config.id, `${chain} is not served by this provider`);
    }
  };

  async function rpc(
    ctx: RunContext,
    method: string,
    params: unknown[],
    purpose: string,
    identifying: boolean,
  ): Promise<{ result: unknown; error?: unknown; fetchId: Id }> {
    const { data, fetchId } = await requestJson<Record<string, unknown>>(
      ctx,
      {
        providerId: config.id,
        sourceId: config.sourceId,
        url: config.baseUrl,
        method: 'POST',
        // `id` is always 1 and the key order is fixed: identical calls give byte-identical bodies.
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        headers: { 'content-type': 'application/json' },
        purpose,
        containsIdentifier: identifying,
      },
      { breaker, classify, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );
    return { result: data['result'], ...(data['error'] === undefined ? {} : { error: data['error'] }), fetchId };
  }

  return {
    id: config.id,
    chains: config.chains,

    async getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip> {
      assertChain(chain);
      const slotAnswer = await rpc(ctx, 'getSlot', [{ commitment: 'finalized' }], 'solana chain tip', false);
      let slot = Number(integerText(slotAnswer.result));
      if (!Number.isSafeInteger(slot)) {
        throw new ChainProviderError('invalid_response', config.id, 'unexpected getSlot body', {
          fetchId: slotAnswer.fetchId,
        });
      }
      for (let step = 0; step < MAX_TIP_STEPS; step += 1) {
        // Sequential on purpose: a skipped slot sends the next call one slot back.
        // oxlint-disable-next-line no-await-in-loop
        const block = await rpc(
          ctx,
          'getBlock',
          [
            slot,
            {
              transactionDetails: 'none',
              rewards: false,
              maxSupportedTransactionVersion: 0,
              commitment: 'finalized',
            },
          ],
          'solana chain tip',
          false,
        );
        const hash = isRecord(block.result) ? text(block.result['blockhash']) : undefined;
        if (block.error === undefined && hash) {
          return { height: slot, hash, observedAt: ctx.clock.now().toISOString() };
        }
        if (block.error === undefined) {
          throw new ChainProviderError('invalid_response', config.id, 'getBlock without blockhash', {
            fetchId: block.fetchId,
          });
        }
        slot -= 1;
      }
      throw new ChainProviderError('upstream_error', config.id, `no block found in ${MAX_TIP_STEPS} slots`);
    },

    async getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary> {
      assertChain(address.chain);
      const { result, fetchId } = await rpc(
        ctx,
        'getBalance',
        [address.address, { commitment: 'finalized' }],
        'solana account balance',
        true,
      );
      const lamports = isRecord(result) ? integerText(result['value']) : undefined;
      if (lamports === undefined) {
        throw new ChainProviderError('invalid_response', config.id, 'unexpected getBalance body', { fetchId });
      }
      return { address, txCount: 0, balance: baseUnitsToDecimal(lamports, 9), fetchId };
    },

    async listTransfers(address, options, ctx): Promise<TransferPage> {
      assertChain(address.chain);
      const cursor = options.cursor ? decodeCursor<SolanaCursor>(config.id, options.cursor) : {};
      const listing = await rpc(
        ctx,
        'getSignaturesForAddress',
        [
          address.address,
          {
            limit: pageSize,
            ...(cursor.before ? { before: cursor.before } : {}),
            ...(cursor.until ? { until: cursor.until } : {}),
            commitment: 'finalized',
          },
        ],
        'solana signature history',
        true,
      );
      if (!Array.isArray(listing.result)) {
        throw new ChainProviderError('invalid_response', config.id, 'expected a signature array', {
          fetchId: listing.fetchId,
        });
      }
      const entries = listing.result.filter(isRecord);
      const successful = entries.filter((e) => e['err'] === null || e['err'] === undefined);
      const remaining = Math.max(0, maxTransactions - (cursor.read ?? 0));
      const take = successful.slice(0, remaining);
      const items: NormalizedTransfer[] = [];
      const skipped: NonNullable<TransferPage['skipped']> = [];
      for (const entry of take) {
        const signature = text(entry['signature']);
        const slot = Number(integerText(entry['slot']));
        const blockTime = Number(integerText(entry['blockTime']));
        if (!signature) continue;
        if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(blockTime)) {
          // No block time: recorded as skipped, never guessed.
          skipped.push({ txHash: signature, reason: 'invalid_amount' });
          continue;
        }
        // Sequential on purpose: one request at a time per provider.
        // oxlint-disable-next-line no-await-in-loop
        const answer = await rpc(
          ctx,
          'getTransaction',
          [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }],
          'solana transaction',
          true,
        );
        if (!isRecord(answer.result) || !isRecord(answer.result['transaction'])) {
          skipped.push({ txHash: signature, reason: 'invalid_amount' });
          continue;
        }
        items.push(
          ...parseSolanaTransfers(
            answer.result as unknown as SolanaParsedTx,
            address.address,
            answer.fetchId,
            {
              signature,
              slot,
              blockTime,
            },
            skipped,
          ),
        );
      }
      const last = text(entries.at(-1)?.['signature']);
      const exhausted = successful.length > take.length;
      return {
        items,
        // Token receipts go to the owner's token accounts, whose signatures are not listed here.
        notes: ['token_accounts_not_scanned'],
        ...(skipped.length > 0 ? { skipped } : {}),
        // The budget stopped the listing: what was read is kept and the history is reported as incomplete.
        ...(exhausted || ((cursor.read ?? 0) + take.length >= maxTransactions && entries.length >= pageSize)
          ? { truncated: true }
          : {}),
        ...(!exhausted && entries.length >= pageSize && last && (cursor.read ?? 0) + take.length < maxTransactions
          ? {
              nextCursor: encodeCursor(config.id, {
                before: last,
                ...(cursor.until ? { until: cursor.until } : {}),
                read: (cursor.read ?? 0) + take.length,
              } satisfies SolanaCursor),
            }
          : {}),
      };
    },
  };
}
