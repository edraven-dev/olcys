/**
 * Chains the console offers in the case form, mirroring `KNOWN_CHAINS` from `@olcys/core` (a test keeps them
 * equal). The console imports only types from core so that the browser bundle stays free of server-side code.
 */
import type { ChainId } from '@olcys/core';
import { pl } from '../i18n/pl.ts';

export interface ConsoleChain {
  id: ChainId;
  nativeAsset: string;
}

export const CONSOLE_CHAINS: readonly ConsoleChain[] = [
  { id: 'bitcoin', nativeAsset: 'BTC' },
  { id: 'litecoin', nativeAsset: 'LTC' },
  { id: 'dogecoin', nativeAsset: 'DOGE' },
  { id: 'bitcoincash', nativeAsset: 'BCH' },
  { id: 'evm:1', nativeAsset: 'ETH' },
  { id: 'evm:10', nativeAsset: 'ETH' },
  { id: 'evm:56', nativeAsset: 'BNB' },
  { id: 'evm:100', nativeAsset: 'xDAI' },
  { id: 'evm:137', nativeAsset: 'POL' },
  { id: 'evm:8453', nativeAsset: 'ETH' },
  { id: 'evm:42161', nativeAsset: 'ETH' },
  { id: 'evm:59144', nativeAsset: 'ETH' },
  { id: 'evm:unknown', nativeAsset: 'ETH' },
  { id: 'tron', nativeAsset: 'TRX' },
  { id: 'solana', nativeAsset: 'SOL' },
  { id: 'xrp', nativeAsset: 'XRP' },
  { id: 'monero', nativeAsset: 'XMR' },
  { id: 'cardano', nativeAsset: 'ADA' },
  { id: 'ton', nativeAsset: 'TON' },
  { id: 'lightning', nativeAsset: 'BTC' },
  { id: 'zcash', nativeAsset: 'ZEC' },
];

/** Default scope of a new case. */
export const DEFAULT_CHAINS: readonly ChainId[] = ['bitcoin', 'evm:1', 'tron'];

export function chainName(chain: string): string {
  return Object.hasOwn(pl.chains, chain) ? (pl.chains[chain as keyof typeof pl.chains] ?? chain) : chain;
}

export function nativeAsset(chain: string): string | undefined {
  return CONSOLE_CHAINS.find((c) => c.id === chain)?.nativeAsset;
}
