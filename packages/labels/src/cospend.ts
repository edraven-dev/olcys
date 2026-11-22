/**
 * Bitcoin co-spend (multi-input) clustering: addresses spent together in one transaction are assumed to share an
 * owner (Meiklejohn heuristic 1), seeded by the subject's addresses. A HEURISTIC, never a fact:
 *  - CoinJoin-shaped and collaborative transactions are skipped (`coSpendGuard`);
 *  - a labelled service spent together with a seed is recorded (`serviceMembers`, rule A7) and never merged, so its
 *    other partners are not absorbed;
 *  - the cluster stops growing at `maxClusterSize` (`capped`, `cap_reached`);
 *  - NO change-address heuristic: an output is never merged with the inputs.
 * Ids and member order depend only on the members, never on the order the transactions arrive in.
 */
import { createHash } from 'node:crypto';
import type {
  AddressCluster,
  ClusterSkipReason,
  ExclusionDecision,
  Id,
  LabelLookup,
  UtxoTransaction,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { coSpendGuard } from './coinjoin.ts';
import type { ExclusionRulesConfig } from './config.ts';
import { isDecidingService } from './exclusions.ts';

export const COSPEND_ALGORITHM_VERSION = 'cospend.v1';

export interface CoSpendDeps {
  labels: LabelLookup;
  /** Transactions already fetched by txid: the Whirlpool tx0 / remix check reads the transaction an input spends. */
  prevTxs: ReadonlyMap<string, UtxoTransaction>;
  rules: ExclusionRulesConfig;
  /** Default: `rules.a7.maxClusterSize`. */
  maxClusterSize?: number;
  /** Seed → size of its cluster in the previous run (growth factor). */
  previousSizes?: ReadonlyMap<string, number>;
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `c_` + the first 16 hex characters of SHA-256 over the sorted member list joined by a newline. */
export function clusterId(members: readonly string[]): string {
  return `c_${createHash('sha256').update(members.toSorted(text).join('\n')).digest('hex').slice(0, 16)}`;
}

interface Accepted {
  txid: string;
  /** Non-service input addresses (sorted, distinct). */
  addresses: string[];
}

interface Skip {
  txid: string;
  reason: ClusterSkipReason;
  addresses: string[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly sizes = new Map<string, number>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      this.sizes.set(x, 1);
      return x;
    }
    let current = x;
    while (root !== current) {
      current = root;
      root = this.parent.get(current) ?? current;
    }
    // Path compression.
    let node = x;
    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  size(root: string): number {
    return this.sizes.get(root) ?? 1;
  }

  /** Union by size; the smaller root (by code point) wins a tie, so the result never depends on call order. */
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [big, small] =
      this.size(ra) > this.size(rb) || (this.size(ra) === this.size(rb) && ra < rb) ? [ra, rb] : [rb, ra];
    this.parent.set(small, big);
    this.sizes.set(big, this.size(big) + this.size(small));
  }

  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

/** Confirmed transactions in a fixed order (block height, then txid), one per txid. */
function ordered(txs: readonly UtxoTransaction[]): UtxoTransaction[] {
  const byTxid = new Map<string, UtxoTransaction>();
  for (const tx of txs) if (tx.blockHeight !== undefined && !byTxid.has(tx.txid)) byTxid.set(tx.txid, tx);
  return [...byTxid.values()].toSorted((a, b) => (a.blockHeight ?? 0) - (b.blockHeight ?? 0) || text(a.txid, b.txid));
}

/**
 * The co-spend clusters of the seeds (one per group of seeds that ended up together; a seed that merged with nothing
 * is a cluster of one). `txs` are the fetched histories of the seeds and of the expanded co-spend partners.
 */
export async function buildCoSpendClusters(
  seeds: readonly string[],
  txs: readonly UtxoTransaction[],
  deps: CoSpendDeps,
  runId: Id,
): Promise<AddressCluster[]> {
  const cap = deps.maxClusterSize ?? deps.rules.a7.maxClusterSize;
  const seedList = [...new Set(seeds)].toSorted(text);
  const serviceLabel = new Map<string, Id | undefined>();
  const serviceOf = async (address: string): Promise<Id | undefined> => {
    if (!serviceLabel.has(address)) {
      const labels = await deps.labels.labelsFor({ chain: 'bitcoin', address });
      serviceLabel.set(address, labels.find((l) => isDecidingService(l, deps.rules.a1.trustOrder))?.id);
    }
    return serviceLabel.get(address);
  };

  const uf = new UnionFind();
  const accepted: Accepted[] = [];
  const skips: Skip[] = [];
  const serviceLinks: { addresses: string[]; services: { address: string; labelId: Id }[] }[] = [];

  for (const tx of ordered(txs)) {
    const all = [...new Set(tx.inputs.flatMap((i) => (i.address ? [i.address] : [])))].toSorted(text);
    // Coinbase and address-less inputs never merge; a single input address has nothing to merge.
    if (all.length < 2) continue;
    const guard = coSpendGuard(tx, deps);
    if (guard) {
      skips.push({ txid: tx.txid, reason: guard, addresses: all });
      continue;
    }
    const own: string[] = [];
    const services: { address: string; labelId: Id }[] = [];
    for (const address of all) {
      // oxlint-disable-next-line no-await-in-loop
      const labelId = await serviceOf(address);
      if (labelId === undefined) own.push(address);
      else services.push({ address, labelId });
    }
    if (services.length > 0 && own.length > 0) serviceLinks.push({ addresses: own, services });
    if (own.length < 2) continue;
    const roots = [...new Set(own.map((a) => uf.find(a)))];
    if (roots.length === 1) {
      accepted.push({ txid: tx.txid, addresses: own });
      continue;
    }
    const total = roots.reduce((sum, root) => sum + uf.size(root), 0);
    if (total > cap) {
      skips.push({ txid: tx.txid, reason: 'cap_reached', addresses: own });
      continue;
    }
    for (const address of own.slice(1)) uf.union(own[0] ?? address, address);
    accepted.push({ txid: tx.txid, addresses: own });
  }

  const txsOf = new Map<string, Accepted[]>();
  for (const tx of accepted) {
    for (const address of tx.addresses) {
      const list = txsOf.get(address) ?? [];
      list.push(tx);
      txsOf.set(address, list);
    }
  }
  const membersOf = new Map<string, string[]>();
  for (const node of uf.nodes()) {
    const root = uf.find(node);
    const list = membersOf.get(root) ?? [];
    list.push(node);
    membersOf.set(root, list);
  }

  const groups = new Map<string, string[]>();
  for (const seed of seedList) {
    const root = uf.find(seed);
    groups.set(root, [...(groups.get(root) ?? []), seed]);
  }

  const clusters: AddressCluster[] = [];
  for (const [root, groupSeeds] of groups) {
    const members = (membersOf.get(root) ?? [root]).toSorted(text);
    const inCluster = new Set(members);
    // Breadth-first from the seeds over the merging transactions: each member's evidence is the first transaction
    // that connects it to what is already reached.
    const reached = new Set(groupSeeds);
    const queue = [...groupSeeds];
    const mergeEvidence: AddressCluster['mergeEvidence'] = [];
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i] ?? '';
      for (const tx of txsOf.get(current) ?? []) {
        for (const address of tx.addresses) {
          if (reached.has(address)) continue;
          reached.add(address);
          queue.push(address);
          mergeEvidence.push({ address, txid: tx.txid });
        }
      }
    }
    const skipped: AddressCluster['skipped'] = [];
    const seen = new Set<string>();
    for (const skip of skips) {
      const key = `${skip.txid}|${skip.reason}`;
      if (seen.has(key) || !skip.addresses.some((a) => inCluster.has(a))) continue;
      seen.add(key);
      skipped.push({ txid: skip.txid, reason: skip.reason });
    }
    const serviceMembers = new Map<string, { address: string; labelId: Id }>();
    for (const link of serviceLinks) {
      if (!link.addresses.some((a) => inCluster.has(a))) continue;
      for (const service of link.services)
        if (!serviceMembers.has(service.address)) serviceMembers.set(service.address, service);
    }
    const services = [...serviceMembers.values()].toSorted((a, b) => text(a.address, b.address));
    const previous = groupSeeds
      .map((seed) => deps.previousSizes?.get(seed))
      .filter((n): n is number => n !== undefined && n > 0);
    const previousSize = previous.length ? Math.max(...previous) : undefined;
    const cluster: AddressCluster = {
      id: clusterId(members),
      runId,
      chain: 'bitcoin',
      heuristic: 'co_spend',
      algorithmVersion: COSPEND_ALGORITHM_VERSION,
      seeds: groupSeeds,
      members,
      size: members.length,
      ...(previousSize !== undefined ? { previousSize } : {}),
      mergeEvidence,
      skipped,
      serviceMembers: services,
      flags: {
        serviceMerge: services.length > 0,
        capped: skipped.some((s) => s.reason === 'cap_reached'),
        ...(previousSize !== undefined
          ? { growthFactor: Math.round((members.length / previousSize) * 100) / 100 }
          : {}),
      },
    };
    clusters.push(cluster);
  }
  return clusters.toSorted((a, b) => text(a.id, b.id));
}

/**
 * Co-spend partners worth fetching next: members of the clusters whose history is not fetched yet (the frontier), in
 * merge order, at most `maxAddresses`. `round` is the expansion round (1 = partners of the seeds); nothing is returned
 * beyond `maxDepth`. Labelled services and deny-listed addresses (`exclude`) are never returned.
 */
export function planClusterExpansion(
  clusters: readonly AddressCluster[],
  fetched: ReadonlySet<string>,
  opts: { maxDepth: number; round?: number; maxAddresses: number; exclude: (address: string) => boolean },
): string[] {
  if ((opts.round ?? 1) > opts.maxDepth) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    const seeds = new Set(cluster.seeds);
    for (const { address } of cluster.mergeEvidence) {
      if (out.length >= opts.maxAddresses) return out;
      if (seeds.has(address) || fetched.has(address) || seen.has(address) || opts.exclude(address)) continue;
      seen.add(address);
      out.push(address);
    }
  }
  return out;
}

/** What rule A7 needs to know about a cluster. */
export interface ClusterSummary {
  clusterId: string;
  seeds: string[];
  size: number;
  previousSize?: number;
  growthFactor?: number;
  serviceMerge: boolean;
  /** Addresses of the labelled services spent together with the cluster. */
  serviceMembers: string[];
  /** Labels that identify those services (evidence of the flag). */
  serviceLabelIds: Id[];
  capped: boolean;
}

export function toClusterSummary(c: AddressCluster): ClusterSummary {
  return {
    clusterId: c.id,
    seeds: c.seeds,
    size: c.size,
    ...(c.previousSize !== undefined ? { previousSize: c.previousSize } : {}),
    ...(c.flags.growthFactor !== undefined ? { growthFactor: c.flags.growthFactor } : {}),
    serviceMerge: c.flags.serviceMerge,
    serviceMembers: c.serviceMembers.map((s) => s.address),
    serviceLabelIds: [...new Set(c.serviceMembers.map((s) => s.labelId))],
    capped: c.flags.capped,
  };
}

/**
 * Rule A7 (cluster collapse): a cluster that took in a labelled service, hit the size cap or grew by `minGrowthFactor`
 * since the previous run is flagged — one `flagged` decision per seed, never an exclusion. The flag says the
 * co-spend heuristic is unreliable for this seed; the cluster stays a computed hint.
 */
export function evaluateClusterCollapse(
  summary: ClusterSummary,
  deps: { rules: ExclusionRulesConfig; runId: Id },
): ExclusionDecision[] {
  const reasons: string[] = [];
  if (summary.serviceMerge) {
    reasons.push(`spent together with the labelled service ${summary.serviceMembers.join(', ')}`);
  }
  if (summary.capped) reasons.push(`reached the size cap of ${deps.rules.a7.maxClusterSize} addresses`);
  if (summary.growthFactor !== undefined && summary.growthFactor >= deps.rules.a7.minGrowthFactor) {
    reasons.push(`grew ×${summary.growthFactor} since the previous run (${summary.previousSize} → ${summary.size})`);
  }
  if (reasons.length === 0) return [];
  return summary.seeds.map((address) => ({
    id: newId(),
    runId: deps.runId,
    address: { chain: 'bitcoin', address },
    ruleId: 'A7',
    rulesVersion: deps.rules.version,
    outcome: 'flagged',
    reason: `A7: the co-spend cluster ${summary.clusterId} (${summary.size} addresses, heuristic) ${reasons.join('; ')}`,
    evidence: {
      ...(summary.serviceLabelIds.length ? { labelIds: summary.serviceLabelIds } : {}),
      cluster: {
        id: summary.clusterId,
        size: summary.size,
        ...(summary.previousSize !== undefined ? { previousSize: summary.previousSize } : {}),
        ...(summary.growthFactor !== undefined ? { growthFactor: summary.growthFactor } : {}),
        ...(summary.serviceMembers.length ? { serviceMembers: summary.serviceMembers } : {}),
        ...(summary.capped ? { capped: true } : {}),
      },
    },
  }));
}
