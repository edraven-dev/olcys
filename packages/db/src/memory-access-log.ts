/** In-memory access log: the SQL contract (append-only, newest first by `at` then `id`, optional case/actor filter). */
import type { AccessLogRepository } from '@olcys/core';

export function memoryAccessLogRepository(): AccessLogRepository {
  const stored: Parameters<AccessLogRepository['add']>[0][] = [];
  return {
    async add(entry) {
      stored.push(structuredClone(entry));
    },
    async list(query = {}) {
      return stored
        .filter(
          (e) =>
            (query.caseId === undefined || e.caseId === query.caseId) &&
            (query.actor === undefined || e.actor === query.actor),
        )
        .toSorted((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
        .slice(0, query.limit ?? 100)
        .map((e) => structuredClone(e));
    },
  };
}
