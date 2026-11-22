import type { ChainId } from './chains.ts';
import type { Id } from './common.ts';

/** Why a transaction was left out of a co-spend cluster (a guard fired or the size cap was reached). */
export const CLUSTER_SKIP_REASONS = [
  'coinjoin_wasabi',
  'coinjoin_whirlpool',
  'equal_outputs',
  'collaborative_escrow',
  'cap_reached',
] as const;
export type ClusterSkipReason = (typeof CLUSTER_SKIP_REASONS)[number];

/**
 * A group of Bitcoin addresses the multi-input (co-spend) heuristic puts under one owner. A HEURISTIC result
 * (computed, never a fact): addresses spent together in one transaction are assumed to share an owner, except in
 * CoinJoin-shaped and collaborative transactions, which are skipped. Change-address heuristics are not used.
 */
export interface AddressCluster {
  /** `c_` + the first 16 hex characters of SHA-256 over the sorted member list joined by `\n`. */
  id: string;
  runId: Id;
  chain: ChainId;
  heuristic: 'co_spend';
  /** `cospend.v1` */
  algorithmVersion: string;
  /** The subject's addresses the cluster grew from (sorted). */
  seeds: string[];
  /** Every address of the cluster, seeds included (sorted by code point). */
  members: string[];
  size: number;
  /** Size of the cluster of the same seed in the previous run. */
  previousSize?: number;
  /** The first transaction that merged each non-seed member into the cluster, in merge (breadth-first) order. */
  mergeEvidence: { address: string; txid: string }[];
  /** Transactions spending from the cluster that were not used to merge, and why. */
  skipped: { txid: string; reason: ClusterSkipReason }[];
  /** Labelled services spent together with the cluster: never merged, the cluster is flagged (rule A7). */
  serviceMembers: { address: string; labelId: Id }[];
  flags: { serviceMerge: boolean; capped: boolean; growthFactor?: number };
}
