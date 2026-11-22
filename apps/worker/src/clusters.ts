/**
 * Bitcoin co-spend clustering for the chain stage: bounded expansion fetches of the co-spend partners of the
 * subject's addresses (through the same providers and egress client as every other chain request), then the clusters.
 * The expansion discloses partner addresses to the configured Bitcoin provider; it is bounded (≤ 200 addresses, depth
 * ≤ 2, ≤ 5 pages each) and never reaches labelled services or deny-listed addresses.
 */
import { runChainFetch, type ChainFetchOutcome, type TipCache } from '@olcys/chain-adapters';
import type { AddressCluster, Id, RunContext, UtxoTransaction } from '@olcys/core';
import {
  buildCoSpendClusters,
  effectiveOutcome,
  planClusterExpansion,
  prescreenExclusions,
  type ExclusionDeps,
} from '@olcys/labels';

/** Bounds of the expansion (ticket limits): addresses fetched, hops from the seeds, pages per address. */
export const CLUSTER_EXPANSION = { maxAddresses: 200, maxDepth: 2, maxPages: 5 } as const;

export interface ClusterRunInput {
  /** The subject's Bitcoin addresses that were fetched (the cluster seeds). */
  seeds: readonly string[];
  /** Histories already fetched (of the seeds and of other analysed addresses). */
  txs: readonly UtxoTransaction[];
  /** Addresses whose history is already in `txs`. */
  fetched: ReadonlySet<string>;
  exclusionDeps: ExclusionDeps;
  previousSizes?: ReadonlyMap<string, number>;
  providers: Parameters<typeof runChainFetch>[1];
  runCtx: RunContext;
  chainSources: readonly string[];
  tips: TipCache;
  runId: Id;
}

export interface ClusterRunResult {
  clusters: AddressCluster[];
  /** Outcomes of the expansion fetches (their gaps make the run partial). */
  outcomes: ChainFetchOutcome[];
  /** Co-spend partners whose history was fetched. */
  expanded: number;
}

export async function clusterBitcoin(input: ClusterRunInput): Promise<ClusterRunResult> {
  const { exclusionDeps } = input;
  const known = new Map<string, UtxoTransaction>();
  const remember = (txs: readonly UtxoTransaction[]): void => {
    for (const tx of txs) if (tx.chain === 'bitcoin' && !known.has(tx.txid)) known.set(tx.txid, tx);
  };
  remember(input.txs);
  const fetched = new Set(input.fetched);
  const outcomes: ChainFetchOutcome[] = [];
  const build = (): Promise<AddressCluster[]> =>
    buildCoSpendClusters(
      input.seeds,
      [...known.values()],
      {
        labels: exclusionDeps.labels,
        prevTxs: known,
        rules: exclusionDeps.rules,
        ...(input.previousSizes ? { previousSizes: input.previousSizes } : {}),
      },
      input.runId,
    );

  // A labelled service or a deny-listed address is never a partner to expand (decided once per address).
  const blocked = new Map<string, boolean>();
  const isBlocked = async (address: string): Promise<boolean> => {
    const cached = blocked.get(address);
    if (cached !== undefined) return cached;
    const pre = await prescreenExclusions({ chain: 'bitcoin', address }, exclusionDeps);
    const result = effectiveOutcome(pre).outcome === 'excluded';
    blocked.set(address, result);
    return result;
  };

  let clusters = await build();
  let expanded = 0;
  for (let round = 1; round <= CLUSTER_EXPANSION.maxDepth; round += 1) {
    const frontier = [...new Set(clusters.flatMap((c) => c.members))].filter((a) => !fetched.has(a));
    // Sequential on purpose: cheap local label lookups.
    for (const address of frontier) {
      // oxlint-disable-next-line no-await-in-loop
      await isBlocked(address);
    }
    const plan = planClusterExpansion(clusters, fetched, {
      maxDepth: CLUSTER_EXPANSION.maxDepth,
      round,
      maxAddresses: CLUSTER_EXPANSION.maxAddresses - expanded,
      exclude: (address) => blocked.get(address) === true,
    });
    if (plan.length === 0) break;
    // oxlint-disable-next-line no-await-in-loop
    const result = await runChainFetch(
      plan.map((address) => ({
        address: { chain: 'bitcoin' as const, address },
        want: { summary: false, transfers: false, code: false, utxo: true },
        maxPages: CLUSTER_EXPANSION.maxPages,
      })),
      input.providers,
      input.runCtx,
      { enabledSources: [...input.chainSources], tips: input.tips },
    );
    outcomes.push(...result.outcomes);
    remember(result.utxoTxs);
    for (const address of plan) fetched.add(address);
    expanded += plan.length;
    // oxlint-disable-next-line no-await-in-loop
    clusters = await build();
  }
  return { clusters, outcomes, expanded };
}
