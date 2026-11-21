/**
 * Selections over the chain data of a run, used by the chain stage: which transfers belong to an address, whether the
 * fetched histories are complete, and whether an extracted address was published by its owner.
 */
import type { ChainFetchOutcome, ChainFetchStatus } from '@olcys/chain-adapters';
import type { AddressRef, NormalizedTransfer, RoleCue, UtxoTransaction } from '@olcys/core';
import { addressKey, chainFamily } from '@olcys/core';

/** Fetch results that leave a history complete (`not_found`: the address has no history). */
const COMPLETE: ReadonlySet<ChainFetchStatus> = new Set<ChainFetchStatus>(['ok', 'not_found']);
/** Cues of a first-person statement: the address was published by its author, not merely mentioned. */
const OWNER_CUES: ReadonlySet<RoleCue> = new Set<RoleCue>(['first_person_owner', 'exchange_deposit']);
/** Cues that the address is someone else's: quoted, warned or reported about, or one entry of a list. */
const THIRD_PARTY_CUES: ReadonlySet<RoleCue> = new Set<RoleCue>(['quote', 'warning', 'scam_report', 'listing']);

/** True when a mention states the address as the author's own: an owner cue and no third-party cue. */
export function isOwnStatement(cues: readonly RoleCue[]): boolean {
  return cues.some((cue) => OWNER_CUES.has(cue)) && !cues.some((cue) => THIRD_PARTY_CUES.has(cue));
}

/**
 * The transfers of an address. UTXO transfers are an account-style view whose sender is the first input with an
 * address, so an address that spends together with others owns the payments of every transaction it spends in
 * (outputs back to it are change, not payments), plus the outputs it receives. Without UTXO data (account chains)
 * the endpoints decide.
 */
export function transfersOf(
  address: AddressRef,
  transfers: readonly NormalizedTransfer[],
  utxoTxs: readonly UtxoTransaction[],
): NormalizedTransfer[] {
  const own = address.address.toLowerCase();
  const same =
    chainFamily(address.chain) === 'evm'
      ? (x: string) => x.toLowerCase() === own
      : (x: string) => x === address.address;
  const spends = new Set(
    utxoTxs
      .filter((tx) => tx.chain === address.chain && tx.inputs.some((input) => input.address && same(input.address)))
      .map((tx) => tx.txid),
  );
  return transfers.filter(
    (t) => t.chain === address.chain && (spends.has(t.txHash) ? !same(t.to) : same(t.to) || same(t.from)),
  );
}

/**
 * Why fetched histories are incomplete (undefined when none is), e.g. `2 address(es): tron no enabled provider (1),
 * evm:1 truncated (1)`. The last attempt per address and chain decides: a provider that failed over to the next one
 * leaves no gap.
 */
export function incompleteHistories(outcomes: readonly ChainFetchOutcome[]): string | undefined {
  const last = new Map<string, ChainFetchOutcome>();
  for (const outcome of outcomes) last.set(`${addressKey(outcome.address)}|${outcome.chain}`, outcome);
  const counts = new Map<string, number>();
  for (const outcome of last.values()) {
    if (COMPLETE.has(outcome.status)) continue;
    // Without a provider id no provider was tried: none of the case's enabled providers serves the chain.
    const status = outcome.status === 'unsupported' && !outcome.providerId ? 'no enabled provider' : outcome.status;
    const key = `${outcome.chain} ${status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return `${total} address(es): ${[...counts].map(([key, n]) => `${key} (${n})`).join(', ')}`;
}
