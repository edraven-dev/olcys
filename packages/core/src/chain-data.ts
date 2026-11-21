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
  fetchId: Id;
}

/** UTXO-model transaction (Bitcoin family), needed for co-spend clustering and CoinJoin detection. */
export interface UtxoTransaction {
  chain: ChainId;
  txid: string;
  blockHeight?: number;
  blockTime?: IsoDateTime;
  inputs: { address?: string; value: DecimalString; prevTxid: string; vout: number }[];
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
