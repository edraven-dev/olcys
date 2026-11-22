/**
 * In-memory address-type classifications: the SQL contract (append-only, one per run, chain and address, the run must
 * exist, listed by chain then address).
 */
import type { AddressTypeClassification, AddressTypeRepository, Id } from '@olcys/core';
import { addressKey } from '@olcys/core';

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function memoryAddressTypeRepository(runs: ReadonlyMap<Id, unknown>): AddressTypeRepository {
  const stored: { runId: Id; classification: AddressTypeClassification }[] = [];
  return {
    async add(runId, classifications) {
      if (classifications.length && !runs.has(runId)) throw new Error(`run ${runId} not found`);
      const seen = new Set(stored.filter((s) => s.runId === runId).map((s) => addressKey(s.classification.address)));
      for (const c of classifications) {
        const key = addressKey(c.address);
        if (seen.has(key)) throw new Error(`address type of ${key} already stored for run ${runId}`);
        seen.add(key);
      }
      stored.push(...classifications.map((c) => ({ runId, classification: structuredClone(c) })));
    },
    async list(runId) {
      return stored
        .filter((s) => s.runId === runId)
        .map((s) => structuredClone(s.classification))
        .toSorted((a, b) => text(a.address.chain, b.address.chain) || text(a.address.address, b.address.address));
    },
  };
}
