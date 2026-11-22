/**
 * Test doubles for the address-type classifier: a run context that refuses any network access and a scripted
 * `ChainProvider` (getCode / getStorageAt / call answered from tables) that records every request in call order.
 * Addresses are synthetic.
 */
import type { AddressRef, ChainCallResult, ChainProvider, RunContext } from '@olcys/core';
import { newId } from '@olcys/core';

export const ctx: RunContext = {
  runId: newId(),
  caseId: newId(),
  mode: 'offline',
  http: { fetch: () => Promise.reject(new Error('tests never use the network')) },
  blobs: {
    put: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    has: () => Promise.resolve(false),
  },
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

/** A failure as the chain adapters raise it (`ChainProviderError`, recognised by name). */
export function providerError(message: string, fetchId?: string): Error {
  return Object.assign(new Error(message), { name: 'ChainProviderError', ...(fetchId ? { fetchId } : {}) });
}

export interface Script {
  /** Address → code (`0x` when absent). */
  code?: Record<string, string>;
  /** `address|slot` → storage word (zero word when absent). */
  storage?: Record<string, string>;
  /** `address|selector` → return data or `revert` (revert when absent). */
  calls?: Record<string, string>;
  /** Request (e.g. `getStorageAt 0x0`) → error thrown instead of an answer. */
  failures?: Record<string, Error>;
  /** Port methods the provider does not implement. */
  without?: ('getStorageAt' | 'call')[];
}

export type ScriptedProvider = ChainProvider & { requests: string[] };

const ZERO_WORD = `0x${'0'.repeat(64)}`;

/** Each answer gets the fetch id `f<n>` (1-based, in request order). */
export function scriptedProvider(script: Script): ScriptedProvider {
  const requests: string[] = [];
  const answer = <T>(request: string, value: (fetchId: string) => T): Promise<T> => {
    requests.push(request);
    const failure = script.failures?.[request];
    if (failure) return Promise.reject(failure);
    return Promise.resolve(value(`f${requests.length}`));
  };
  const provider: ScriptedProvider = {
    id: 'scripted',
    chains: ['evm:1', 'tron'],
    requests,
    getTip: () => Promise.reject(new Error('not used')),
    getAddressSummary: () => Promise.reject(new Error('not used')),
    listTransfers: () => Promise.reject(new Error('not used')),
    getCode: (address: AddressRef) =>
      answer('getCode', (fetchId) => ({ code: script.code?.[address.address] ?? '0x', fetchId })),
    getStorageAt: (address: AddressRef, slot: string) =>
      answer(`getStorageAt ${slot}`, (fetchId) => ({
        value: script.storage?.[`${address.address}|${slot}`] ?? ZERO_WORD,
        fetchId,
      })),
    call: (address: AddressRef, data: string) =>
      answer(`call ${data}`, (fetchId): ChainCallResult => {
        const result = script.calls?.[`${address.address}|${data}`];
        return result === undefined || result === 'revert'
          ? { status: 'reverted', fetchId }
          : { status: 'ok', data: result, fetchId };
      }),
  };
  for (const method of script.without ?? []) delete provider[method];
  return provider;
}

/** ABI word holding an address or a number. */
export function word(value: string | number): string {
  const hex = typeof value === 'number' ? value.toString(16) : value.replace(/^0x/, '');
  return `0x${hex.padStart(64, '0')}`;
}
