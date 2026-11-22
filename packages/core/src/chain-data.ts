import type { AddressRef, ChainId } from './chains.ts';
import type { DecimalString, Id, IsoDateTime } from './common.ts';

export interface AssetRef {
  chain: ChainId;
  /** e.g. `BTC`, `ETH`, `USDT`, `USDC`, `EURC`, `EURe`. */
  symbol: string;
  decimals: number;
  /** Token contract (EVM/TRON) or mint (Solana); absent for the native asset. */
  contract?: string;
}

/** Account-model value movement (EVM, TRON, Solana): native, token or internal transfer. */
export interface NormalizedTransfer {
  chain: ChainId;
  txHash: string;
  /** Log index for token transfers / trace index for internal transfers. */
  index?: number;
  blockHeight: number;
  blockHash?: string;
  blockTime: IsoDateTime;
  from: string;
  to: string;
  asset: AssetRef;
  /** Amount in whole units of `asset` (decimals already applied). */
  amount: DecimalString;
  kind: 'native' | 'token' | 'internal';
  /** Method name or 4-byte selector of the top-level call, when known. */
  method?: string;
  /**
   * Set on rows derived for flow queries only: a Bitcoin payment attributed to a co-spending input (the same output as
   * the original row, so a value aggregation must count it once). Such rows start and continue downstream paths only.
   */
  derivedFrom?: 'co_spend';
  fetchId: Id;
}

/** UTXO-model transaction (Bitcoin family), needed for co-spend clustering and CoinJoin detection. */
export interface UtxoTransaction {
  chain: ChainId;
  txid: string;
  blockHeight?: number;
  blockTime?: IsoDateTime;
  inputs: {
    address?: string;
    value: DecimalString;
    prevTxid: string;
    vout: number;
    /** Script of the witness (P2WSH) the input revealed, e.g. `OP_2 … OP_2 OP_CHECKMULTISIG`; absent when unknown. */
    witnessScriptAsm?: string;
  }[];
  outputs: { address?: string; value: DecimalString; n: number; scriptType?: string }[];
  fee?: DecimalString;
  fetchId: Id;
}

export interface AddressSummary {
  address: AddressRef;
  firstSeen?: IsoDateTime;
  lastSeen?: IsoDateTime;
  txCount: number;
  totalReceived?: DecimalString;
  totalSent?: DecimalString;
  balance?: DecimalString;
  fetchId: Id;
}

/** Identity of one transfer within a run: the same on-chain movement fetched for two addresses has one key. */
export function transferKey(t: NormalizedTransfer): string {
  const asset = `${t.asset.symbol}:${t.asset.contract ?? ''}`;
  return [t.chain, t.txHash, t.index ?? '', t.kind, t.from, t.to, asset, t.amount].join('|');
}

/** The transfers without repeats (first occurrence wins, order kept). */
export function uniqueTransfers<T extends NormalizedTransfer>(transfers: readonly T[]): T[] {
  const seen = new Set<string>();
  return transfers.filter((t) => {
    const key = transferKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
