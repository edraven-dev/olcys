/**
 * In-memory schedules for `createMemoryRepositories()`: the same contract as the SQL implementation. Changes and ticks
 * are append-only; `fire` reads and writes without yielding, so it is atomic within the process.
 */
import type {
  ActiveSchedule,
  CaseScheduleChange,
  CaseWithIdentifiers,
  Id,
  RunWithProgress,
  ScheduleRepository,
  ScheduleTick,
} from '@olcys/core';
import { newId } from '@olcys/core';

const copy = <T>(value: T): T => structuredClone(value);
const isActive = (run: RunWithProgress) => run.status === 'queued' || run.status === 'running';
const isCompleted = (run: RunWithProgress) => run.status === 'succeeded' || run.status === 'partial';

export function memoryScheduleRepository(
  cases: Map<Id, CaseWithIdentifiers>,
  runs: Map<Id, RunWithProgress>,
): ScheduleRepository {
  const changes: CaseScheduleChange[] = [];
  const ticks: ScheduleTick[] = [];
  /** Newest first; of changes made at the same instant the later one first, as in SQL (UUIDv7 order). */
  const changesOf = (caseId: Id) =>
    changes
      .filter((c) => c.caseId === caseId)
      .toReversed()
      .toSorted((a, b) => b.at.localeCompare(a.at));
  const ticksOf = (caseId: Id) =>
    ticks
      .filter((t) => t.caseId === caseId)
      .toSorted((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || b.firedAt.localeCompare(a.firedAt));

  return {
    async setSchedule(caseId, schedule, change) {
      const kase = cases.get(caseId);
      if (!kase) return { ok: false, error: 'case_not_found' };
      if (kase.status === 'closed') return { ok: false, error: 'case_closed' };
      const record: CaseScheduleChange = {
        id: newId(),
        caseId,
        ...(kase.schedule ? { before: copy(kase.schedule) } : {}),
        after: copy(schedule),
        changedBy: change.changedBy,
        reason: change.reason,
        at: change.at,
      };
      kase.schedule = copy(schedule);
      changes.push(record);
      return { ok: true, change: copy(record) };
    },

    async listChanges(caseId, limit) {
      return copy(changesOf(caseId).slice(0, limit));
    },

    async listTicks(caseId, limit) {
      return copy(ticksOf(caseId).slice(0, limit));
    },

    async listActive() {
      const active: ActiveSchedule[] = [];
      for (const kase of cases.values()) {
        if (kase.status !== 'open' || !kase.schedule?.enabled) continue;
        const last = ticksOf(kase.id)[0];
        active.push({
          caseId: kase.id,
          schedule: copy(kase.schedule),
          changedAt: changesOf(kase.id)[0]?.at ?? kase.createdAt,
          ...(last ? { lastScheduledFor: last.scheduledFor } : {}),
        });
      }
      return active;
    },

    async fire(claim, decide) {
      const existing = ticks.find((t) => t.jobId === claim.jobId);
      if (existing) return { tick: copy(existing), claimed: false };
      const kase = cases.get(claim.caseId);
      if (!kase) throw new Error(`case ${claim.caseId} not found`);
      const ofCase = [...runs.values()].filter((r) => r.caseId === claim.caseId);
      const previous = ofCase.findLast(isCompleted);
      const decision = decide({
        case: copy(kase),
        activeRunIds: ofCase.filter(isActive).map((r) => r.id),
        ...(previous ? { previousRunId: previous.id } : {}),
      });
      const run = decision.outcome === 'started' ? decision.run : undefined;
      if (run && run.caseId !== claim.caseId) throw new Error(`a tick of case ${claim.caseId} cannot start ${run.id}`);
      const tick: ScheduleTick = {
        id: newId(),
        caseId: claim.caseId,
        jobId: claim.jobId,
        scheduledFor: claim.scheduledFor,
        firedAt: claim.firedAt,
        outcome: decision.outcome,
        ...(run ? { runId: run.id } : {}),
      };
      ticks.push(tick);
      if (run) runs.set(run.id, { ...copy(run), progress: {} });
      return { tick: copy(tick), claimed: true };
    },
  };
}
