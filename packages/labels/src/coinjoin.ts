/**
 * Transaction shapes that stop co-spend clustering. In these transactions inputs of unrelated owners are spent
 * together on purpose (CoinJoin) or by agreement (collaborative funding), so "inputs spent together share an owner"
 * does not hold. All checks are heuristics on the transaction alone (plus the previous transaction for Whirlpool);
 * PayJoin cannot be detected reliably and is a stated limitation.
 */
import type { ClusterSkipReason, UtxoTransaction } from '@olcys/core';
import { toBaseUnits } from '@olcys/core';
import type { ExclusionRulesConfig } from './config.ts';
import { utxoScriptType } from './utxo-script.ts';

export type CoinJoinKind = Extract<ClusterSkipReason, 'coinjoin_wasabi' | 'coinjoin_whirlpool' | 'equal_outputs'>;

const sats = (value: string): bigint => toBaseUnits(value, 8);

/** The largest group of outputs with one value. */
function equalGroup(tx: UtxoTransaction): { count: number; value: bigint } {
  const counts = new Map<bigint, number>();
  for (const out of tx.outputs) {
    const value = sats(out.value);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = { count: 0, value: 0n };
  for (const [value, count] of counts)
    if (count > best.count || (count === best.count && value > best.value)) best = { count, value };
  return best;
}

/** `5` inputs and `5` equal outputs (one value) of a pool denomination, e.g. a Whirlpool mix. */
function isPoolMix(tx: UtxoTransaction, rules: ExclusionRulesConfig['a6']): bigint | undefined {
  const { inputs, outputs } = rules.whirlpool;
  if (tx.inputs.length !== inputs || tx.outputs.length !== outputs) return undefined;
  const group = equalGroup(tx);
  if (group.count !== outputs) return undefined;
  return rules.whirlpoolPools.some((pool) => BigInt(pool) === group.value) ? group.value : undefined;
}

/** A Whirlpool tx0: it carries an OP_RETURN output and created the premix output (pool denomination plus a fee share). */
function isTx0Output(
  prev: UtxoTransaction,
  vout: number,
  denomination: bigint,
  rules: ExclusionRulesConfig['a6'],
): boolean {
  if (!prev.outputs.some((o) => o.scriptType === 'op_return' || o.scriptType === 'nulldata')) return false;
  const spent = prev.outputs.find((o) => o.n === vout);
  if (!spent) return false;
  const value = sats(spent.value);
  const max = (denomination * BigInt(Math.round(Number(rules.whirlpoolPremixMaxFeeShare) * 1000) + 1000)) / 1000n;
  return value > denomination && value <= max;
}

/**
 * Wasabi (at least `wasabiMinEqualOutputs` equal outputs), Whirlpool (5 inputs, 5 equal outputs at a pool
 * denomination, every input a tx0 premix output or a pool-mix output — checked against `prevTxs`) or the generic
 * equal-output pattern (JoinMarket-like). Undefined when the transaction has none of these shapes.
 */
export function detectCoinJoin(
  tx: UtxoTransaction,
  deps: { prevTxs: ReadonlyMap<string, UtxoTransaction>; rules: ExclusionRulesConfig },
): CoinJoinKind | undefined {
  const a6 = deps.rules.a6;
  if (tx.outputs.length === 0) return undefined;
  const group = equalGroup(tx);
  if (group.count >= a6.wasabiMinEqualOutputs) return 'coinjoin_wasabi';
  const denomination = isPoolMix(tx, a6);
  if (denomination !== undefined) {
    const fromPool = (input: UtxoTransaction['inputs'][number]): boolean => {
      const prev = deps.prevTxs.get(input.prevTxid);
      if (!prev) return false;
      if (isTx0Output(prev, input.vout, denomination, a6)) return true;
      const prevMix = isPoolMix(prev, a6);
      const spent = prev.outputs.find((o) => o.n === input.vout);
      return prevMix === denomination && spent !== undefined && sats(spent.value) === denomination;
    };
    if (!a6.whirlpool.requiresTx0 || tx.inputs.some(fromPool)) return 'coinjoin_whirlpool';
  }
  if (group.count >= a6.equalOutputs.minCount && group.count / tx.outputs.length >= Number(a6.equalOutputs.minShare)) {
    return 'equal_outputs';
  }
  return undefined;
}

const isP2wsh = (out: UtxoTransaction['outputs'][number]): boolean =>
  out.scriptType === 'v0_p2wsh' ||
  (out.scriptType === undefined && out.address !== undefined && utxoScriptType(out.address) === 'p2wsh');

/**
 * A collaborative transaction (Bisq 2-of-2 deposit, dual-funded channel): inputs of at least two addresses fund a
 * P2WSH output, or one input reveals a multisig witness script while other addresses are spent with it.
 */
export function isCollaborativeEscrow(tx: UtxoTransaction): boolean {
  const addresses = new Set(tx.inputs.flatMap((i) => (i.address ? [i.address] : [])));
  if (addresses.size < 2) return false;
  return tx.outputs.some(isP2wsh) || tx.inputs.some((i) => i.witnessScriptAsm?.includes('OP_CHECKMULTISIG') === true);
}

/** The guard that keeps `tx` out of co-spend clustering, if any. */
export function coSpendGuard(
  tx: UtxoTransaction,
  deps: { prevTxs: ReadonlyMap<string, UtxoTransaction>; rules: ExclusionRulesConfig },
): Exclude<ClusterSkipReason, 'cap_reached'> | undefined {
  return detectCoinJoin(tx, deps) ?? (isCollaborativeEscrow(tx) ? 'collaborative_escrow' : undefined);
}
