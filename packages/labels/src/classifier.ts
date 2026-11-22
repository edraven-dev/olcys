/**
 * Address-type classifier: deterministic on-chain checks that tell a person's account from a contract. Since Pectra
 * (EIP-7702) "has code ⇒ contract ⇒ not a person" is wrong: a delegated EOA returns 23 bytes of code yet stays
 * key-controlled, and Safes and ERC-4337 accounts are often personal wallets. EVM decision procedure (the first match
 * wins; the fetch id of every request is recorded, in call order):
 *
 *   1. code `0x` → `eoa`;
 *   2. exactly 23 bytes `0xef0100` ‖ delegate → `delegated_eoa`; another `0xef0100…` length → `unknown` (malformed:
 *      EIP-3541 forbids contracts starting with `0xef`);
 *   3. contract code. A token contract known locally (label `token_contract`, asset registry) needs no probe; else
 *      (a) storage slot 0 holds a Safe singleton of the network → `safe`;
 *      (b) `entryPoint()` returns a known EntryPoint → `erc4337_account` (a Safe with the 4337 module is a Safe);
 *      (c) `totalSupply()` returns a word and `decimals()` a value ≤ 255 → `token_contract`;
 *      (d) otherwise `contract`, with the ERC-1967 implementation when that slot is set.
 *
 * A reverted call is a negative probe, not an error; a provider without `getStorageAt` / `call` skips those probes.
 * Bitcoin is classified locally (script type), TRON by its code alone (an account, a token contract known locally, or
 * a contract); other chains are `unknown`. State reads use `latest`, so the type holds "as of the recorded chain tip".
 * Counterfactual smart accounts (not deployed yet) have no code and look like EOAs.
 */
import type {
  AddressRef,
  AddressTypeClassification,
  AddressTypeProbe,
  ChainProvider,
  Id,
  LabelLookup,
  RunContext,
} from '@olcys/core';
import { chainFamily } from '@olcys/core';
import { utxoScriptType } from './utxo-script.ts';

export interface ClassifierDeps {
  /** The provider that served the address's chain data; without it only local checks run. */
  provider?: ChainProvider;
  labels: LabelLookup;
  /** Token contracts of the asset registry (identified by chain and contract, never by symbol). */
  assets?: { isToken(address: AddressRef): boolean };
  /** Safe singletons by chain id (`loadSafeSingletons`). */
  safeSingletons: ReadonlyMap<string, ReadonlySet<string>>;
  /** ERC-4337 EntryPoints, lower-case (`loadEntryPoints`). */
  entryPoints: ReadonlySet<string>;
  /** Code already fetched for the address (by the chain fetch): step 1 then sends no request. */
  code?: { code: string; fetchId: Id };
}

/** Function selectors of the probes: the first 4 bytes of keccak-256 of the signature (verified in a test). */
export const SELECTORS = {
  entryPoint: '0xb0d691fe',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
} as const;
/** A SafeProxy keeps its singleton (master copy) in storage slot 0. */
export const SAFE_SINGLETON_SLOT = '0x0';
/** ERC-1967 implementation slot: keccak-256("eip1967.proxy.implementation") − 1. */
export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** EIP-7702 delegation designator: `0xef0100` followed by the 20-byte delegate. */
export const DELEGATION_PREFIX = '0xef0100';

/** EIP-7702 delegation in deployed code (pure): the delegate, `malformed` for another length, else undefined. */
export function parseDelegation(code: string): { delegate: string } | 'malformed' | undefined {
  const hex = code.toLowerCase();
  if (!hex.startsWith(DELEGATION_PREFIX)) return undefined;
  const delegate = hex.slice(DELEGATION_PREFIX.length);
  return /^[0-9a-f]{40}$/.test(delegate) ? { delegate: `0x${delegate}` } : 'malformed';
}

const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
const WORD = /^0x[0-9a-f]{64}$/;

/** The address in the low 20 bytes of a 32-byte word whose high 12 bytes are zero; a zero word holds none. */
function addressInWord(value: string): string | undefined {
  const hex = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return undefined;
  const word = hex.padStart(64, '0');
  if (!word.startsWith('0'.repeat(24)) || /^0+$/.test(word)) return undefined;
  return `0x${word.slice(24)}`;
}

/**
 * Expected provider failures (blocked, rate limited, invalid response …) arrive as `ChainProviderError`. Packages see
 * the adapters only through the port, so the error is recognised by name.
 */
function isProviderFailure(error: unknown): error is Error & { fetchId?: Id } {
  return error instanceof Error && error.name === 'ChainProviderError';
}

interface Probes {
  fetchIds: Id[];
  failure?: { probe: AddressTypeProbe; message: string };
}

/** Sends one request, recording its fetch id; an expected failure is recorded and answers `undefined`. */
async function send<T extends { fetchId: Id }>(
  probes: Probes,
  probe: AddressTypeProbe,
  request: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const answer = await request();
    probes.fetchIds.push(answer.fetchId);
    return answer;
  } catch (error) {
    if (!isProviderFailure(error)) throw error;
    if (error.fetchId !== undefined) probes.fetchIds.push(error.fetchId);
    probes.failure ??= { probe, message: error.message };
    return undefined;
  }
}

async function knownToken(address: AddressRef, deps: ClassifierDeps): Promise<boolean> {
  if (deps.assets?.isToken(address)) return true;
  return (await deps.labels.labelsFor(address)).some((l) => l.category === 'token_contract');
}

type Fields = Omit<AddressTypeClassification, 'address' | 'type' | 'fetchIds' | 'failedProbe'>;

async function classifyByCode(
  address: AddressRef,
  deps: ClassifierDeps,
  ctx: RunContext,
  evm: boolean,
): Promise<AddressTypeClassification> {
  const probes: Probes = { fetchIds: [] };
  const result = (type: AddressTypeClassification['type'], fields: Fields = {}): AddressTypeClassification => ({
    address,
    type,
    ...fields,
    ...(probes.failure ? { failedProbe: probes.failure } : {}),
    fetchIds: probes.fetchIds,
  });
  const provider = deps.provider;
  // Optional port methods, bound to their provider.
  const getCode = provider?.getCode?.bind(provider);
  const getStorageAt = provider?.getStorageAt?.bind(provider);
  const ethCall = provider?.call?.bind(provider);

  // 1. Deployed code: an account without code is an EOA.
  let code = deps.code;
  if (code) probes.fetchIds.push(code.fetchId);
  else if (getCode) code = await send(probes, 'code', () => getCode(address, ctx));
  if (!code) return result('unknown');
  const hex = code.code.toLowerCase();
  if (!HEX_BYTES.test(hex)) {
    probes.failure ??= { probe: 'code', message: 'the provider returned code that is not hex bytes' };
    return result('unknown');
  }
  const codeSize = (hex.length - 2) / 2;
  if (codeSize === 0) return result('eoa', { codeSize });

  // 2. EIP-7702 delegation designator (EVM only).
  if (evm) {
    const delegation = parseDelegation(hex);
    if (delegation === 'malformed') return result('unknown', { codePrefix: DELEGATION_PREFIX, codeSize });
    if (delegation) return result('delegated_eoa', { codePrefix: DELEGATION_PREFIX, codeSize, ...delegation });
  }

  // 3. Contract code.
  const contract: Fields = { codePrefix: hex.slice(0, 10), codeSize };
  if (await knownToken(address, deps)) return result('token_contract', contract);
  if (!evm) return result('contract', contract);

  // (a) Safe: the singleton in storage slot 0.
  if (getStorageAt) {
    const slot = await send(probes, 'safe', () => getStorageAt(address, SAFE_SINGLETON_SLOT, ctx));
    // A failed probe cannot rule out a personal smart account.
    if (!slot) return result('unknown', contract);
    const singleton = addressInWord(slot.value);
    if (singleton && deps.safeSingletons.get(address.chain)?.has(singleton)) {
      return result('safe', { ...contract, safeMasterCopy: singleton });
    }
  }
  if (ethCall) {
    // (b) ERC-4337 account: `entryPoint()` names a known EntryPoint.
    const answer = await send(probes, 'erc4337', () => ethCall(address, SELECTORS.entryPoint, ctx));
    if (!answer) return result('unknown', contract);
    const entryPoint = answer.status === 'ok' && WORD.test(answer.data) ? addressInWord(answer.data) : undefined;
    if (entryPoint && deps.entryPoints.has(entryPoint)) return result('erc4337_account', { ...contract, entryPoint });

    // (c) Token: `totalSupply()` returns a word and `decimals()` fits in a byte.
    const supply = await send(probes, 'token', () => ethCall(address, SELECTORS.totalSupply, ctx));
    if (supply?.status === 'ok' && WORD.test(supply.data)) {
      const decimals = await send(probes, 'token', () => ethCall(address, SELECTORS.decimals, ctx));
      if (decimals?.status === 'ok' && WORD.test(decimals.data) && BigInt(decimals.data) <= 255n) {
        return result('token_contract', contract);
      }
    }
    // Either way a contract that is no personal account: the implementation lookup is not worth more requests.
    if (probes.failure) return result('contract', contract);
  }

  // (d) A contract; an ERC-1967 proxy names its implementation (informational).
  if (getStorageAt) {
    const slot = await send(probes, 'implementation', () => getStorageAt(address, ERC1967_IMPLEMENTATION_SLOT, ctx));
    const implementation = slot ? addressInWord(slot.value) : undefined;
    if (implementation) return result('contract', { ...contract, implementation });
  }
  return result('contract', contract);
}

/** Classifies one address (see the module comment for the procedure). Expected provider failures never throw. */
export async function classifyAddress(
  address: AddressRef,
  deps: ClassifierDeps,
  ctx: RunContext,
): Promise<AddressTypeClassification> {
  const family = chainFamily(address.chain);
  if (family === 'bitcoin') {
    const scriptType = utxoScriptType(address.address);
    return scriptType === 'unknown'
      ? { address, type: 'unknown', fetchIds: [] }
      : { address, type: 'utxo_script', scriptType, fetchIds: [] };
  }
  if (family === 'evm' || family === 'tron') return classifyByCode(address, deps, ctx, family === 'evm');
  return { address, type: 'unknown', fetchIds: [] };
}
