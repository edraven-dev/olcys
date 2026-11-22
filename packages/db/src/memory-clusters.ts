/**
 * In-memory co-spend clusters: the SQL contract (append-only, one cluster id per run, the run must exist, listed by
 * id, previous sizes from the newest earlier run of the case).
 */
import type { AddressCluster, ClusterRepository, Id, RunWithProgress } from '@olcys/core';

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function memoryClusterRepository(runs: ReadonlyMap<Id, RunWithProgress>): ClusterRepository {
  const stored: AddressCluster[] = [];
  return {
    async add(runId, clusters) {
      if (clusters.length && !runs.has(runId)) throw new Error(`run ${runId} not found`);
      const seen = new Set(stored.filter((s) => s.runId === runId).map((s) => s.id));
      for (const c of clusters) {
        if (seen.has(c.id)) throw new Error(`cluster ${c.id} already stored for run ${runId}`);
        seen.add(c.id);
      }
      stored.push(...clusters.map((c) => structuredClone({ ...c, runId })));
    },
    async list(runId) {
      return stored
        .filter((s) => s.runId === runId)
        .map((s) => structuredClone(s))
        .toSorted((a, b) => text(a.id, b.id));
    },
    async previousSizes(caseId, seeds, beforeRunId) {
      const sizes = new Map<string, number>();
      const current = runs.get(beforeRunId);
      if (!current) return sizes;
      const earlier = [...runs.values()]
        .filter((r) => r.caseId === caseId && r.id !== beforeRunId && r.queuedAt < current.queuedAt)
        .toSorted((a, b) => text(a.queuedAt, b.queuedAt) || text(a.id, b.id));
      for (const run of earlier) {
        for (const c of stored.filter((s) => s.runId === run.id)) {
          for (const seed of c.seeds) if (seeds.includes(seed)) sizes.set(seed, c.size);
        }
      }
      return sizes;
    },
  };
}
