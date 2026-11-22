/**
 * In-memory time-stamp requests and tokens: the SQL contract (append-only, one token per subject type, subject id and
 * digest, a retry is a new request, pending = latest request queued or failed and no token).
 */
import type {
  Capture,
  CustodyEvent,
  TimestampRepository,
  TimestampRequestRecord,
  TimestampTokenRecord,
} from '@olcys/core';

const copy = <T>(value: T): T => structuredClone(value);
const keyOf = (s: { type: string; id: string; digest: string }): string => `${s.type}:${s.id}:${s.digest}`;
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: TimestampRequestRecord, b: TimestampRequestRecord): number => text(a.at, b.at) || text(a.id, b.id);

export function memoryTimestamps(custody: CustodyEvent[]): {
  repository: TimestampRepository;
  attach(captures: Capture[]): Capture[];
} {
  const requests: TimestampRequestRecord[] = [];
  const tokens = new Map<string, TimestampTokenRecord>();
  return {
    repository: {
      async record({ request, token, custody: events }) {
        requests.push(copy(request));
        if (token) {
          if (tokens.has(keyOf(request.subject))) return { tokenStored: false };
          tokens.set(keyOf(request.subject), copy(token));
        }
        custody.push(...copy(events ?? []));
        return { tokenStored: Boolean(token) };
      },
      async getToken(subject) {
        return copy(tokens.get(keyOf(subject)));
      },
      async listPending(limit = 100) {
        const latest = new Map<string, TimestampRequestRecord>();
        for (const r of requests.toSorted(order)) latest.set(keyOf(r.subject), r);
        return copy(
          [...latest.values()]
            .filter((r) => (r.outcome === 'queued' || r.outcome === 'failed') && !tokens.has(keyOf(r.subject)))
            .toSorted(order)
            .slice(0, limit),
        );
      },
      async listRequests(subjectId) {
        return copy(requests.filter((r) => r.subject.id === subjectId).toSorted(order));
      },
    },
    attach(captures) {
      return captures.map((capture) => {
        const found = tokens.get(keyOf({ type: 'capture_manifest', id: capture.id, digest: capture.manifestSha256 }));
        return found ? { ...capture, timestamp: copy(found.token) } : capture;
      });
    },
  };
}
