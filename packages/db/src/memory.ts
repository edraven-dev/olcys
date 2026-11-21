/**
 * In-memory implementation of the repository ports — same contracts as the SQL implementation, for tests and
 * database-less demos. Append-only like the store it mirrors: only run lifecycle fields change.
 */
import type {
  ActivityIndicators,
  AddressLabel,
  CashOutEvent,
  ChangeEvent,
  CaseWithIdentifiers,
  ExclusionDecision,
  Id,
  LinkAssessment,
  NormalizedTransfer,
  Repositories,
  RunWithProgress,
} from '@olcys/core';
import { addressKey, newId, nowIso } from '@olcys/core';

const copy = <T>(value: T): T => structuredClone(value);
const byRun = <T extends { runId?: Id }>(items: readonly T[], runId: Id): T[] =>
  copy(items.filter((i) => i.runId === runId));

export function createMemoryRepositories(): Repositories {
  const cases = new Map<Id, CaseWithIdentifiers>();
  const runs = new Map<Id, RunWithProgress>();
  const store = {
    egress: [] as Parameters<Repositories['evidence']['addEgressLog']>[0],
    fetches: [] as Parameters<Repositories['evidence']['addRawFetches']>[0],
    captures: [] as Parameters<Repositories['evidence']['addCaptures']>[0],
    accounts: [] as Parameters<Repositories['evidence']['addAccounts']>[0],
    observations: [] as Parameters<Repositories['evidence']['addObservations']>[0],
    extractions: [] as { runId: Id; result: Parameters<Repositories['evidence']['addExtraction']>[1] }[],
    transfers: [] as { runId: Id; transfer: NormalizedTransfer }[],
    exclusions: [] as ExclusionDecision[],
    activity: [] as { runId: Id; indicators: ActivityIndicators }[],
    cashOuts: [] as CashOutEvent[],
    links: [] as LinkAssessment[],
    changes: [] as ChangeEvent[],
    reports: [] as { runId: Id; kind: string; blobSha256: string; mediaType: string; createdAt: string }[],
    labels: new Map<string, AddressLabel>(),
  };

  return {
    cases: {
      async create(input, createdBy) {
        const id = newId();
        const at = nowIso();
        const created: CaseWithIdentifiers = {
          id,
          title: input.title,
          purpose: input.purpose,
          legalBasis: input.legalBasis,
          status: 'open',
          scope: input.scope,
          createdAt: at,
          createdBy,
          identifiers: input.identifiers.map((i) => ({
            id: newId(),
            caseId: id,
            kind: i.kind,
            value: i.value,
            ...(i.platform ? { platform: i.platform } : {}),
            ...(i.chain ? { chain: i.chain } : {}),
            isAnchor: i.isAnchor,
            addedAt: at,
            addedBy: createdBy,
          })),
        };
        cases.set(id, created);
        return copy(created);
      },
      async get(id) {
        const found = cases.get(id);
        return found ? copy(found) : undefined;
      },
      async list() {
        return [...cases.values()].map(({ identifiers: _identifiers, ...c }) => copy(c)).toReversed();
      },
    },
    runs: {
      async create(run) {
        runs.set(run.id, { ...copy(run), progress: {} });
      },
      async update(id, patch) {
        const run = runs.get(id);
        if (!run) throw new Error(`run ${id} not found`);
        const { error, ...rest } = patch;
        const next: RunWithProgress = { ...run, ...copy(rest) };
        if (error === null) delete next.error;
        else if (error !== undefined) next.error = error;
        runs.set(id, next);
      },
      async get(id) {
        const run = runs.get(id);
        return run ? copy(run) : undefined;
      },
      async listByCase(caseId) {
        return copy([...runs.values()].filter((r) => r.caseId === caseId).toReversed());
      },
      async latestCompleted(caseId, excludeRunId) {
        const done = [...runs.values()].filter(
          (r) => r.caseId === caseId && r.id !== excludeRunId && (r.status === 'succeeded' || r.status === 'partial'),
        );
        const last = done.at(-1);
        return last ? copy(last) : undefined;
      },
    },
    evidence: {
      async addEgressLog(entries) {
        store.egress.push(...copy(entries));
      },
      async addRawFetches(envelopes) {
        store.fetches.push(...copy(envelopes));
      },
      async addCaptures(captures) {
        store.captures.push(...copy(captures));
      },
      async addAccounts(accounts) {
        store.accounts.push(...copy(accounts));
      },
      async addObservations(observations) {
        store.observations.push(...copy(observations));
      },
      async addExtraction(runId, result) {
        store.extractions.push({ runId, result: copy(result) });
      },
      async listEgressLog(runId) {
        return byRun(store.egress, runId);
      },
      async listCaptures(runId) {
        return byRun(store.captures, runId);
      },
      async getCapture(id) {
        const found = store.captures.find((c) => c.id === id);
        return found ? copy(found) : undefined;
      },
      async listAccounts(runId) {
        return byRun(store.accounts, runId);
      },
      async listObservations(runId) {
        return byRun(store.observations, runId);
      },
      async listExtractionResults(runId) {
        return copy(store.extractions.filter((e) => e.runId === runId).map((e) => e.result));
      },
      async listCandidates(runId) {
        return copy(store.extractions.filter((e) => e.runId === runId).flatMap((e) => e.result.candidates));
      },
    },
    chain: {
      async addTransfers(runId, _address, transfers) {
        store.transfers.push(...transfers.map((transfer) => ({ runId, transfer: copy(transfer) })));
      },
      async listTransfers(runId) {
        return copy(store.transfers.filter((t) => t.runId === runId).map((t) => t.transfer));
      },
    },
    analysis: {
      async addExclusions(decisions) {
        store.exclusions.push(...copy(decisions));
      },
      async addActivity(runId, indicators) {
        store.activity.push(...indicators.map((i) => ({ runId, indicators: copy(i) })));
      },
      async addCashOuts(events) {
        store.cashOuts.push(...copy(events));
      },
      async addLinks(links) {
        store.links.push(...copy(links));
      },
      async addChanges(changes) {
        store.changes.push(...copy(changes));
      },
      async addReport(report) {
        store.reports.push({ ...report, createdAt: nowIso() });
      },
      async listExclusions(runId) {
        return byRun(store.exclusions, runId);
      },
      async listActivity(runId) {
        return copy(store.activity.filter((a) => a.runId === runId).map((a) => a.indicators));
      },
      async listCashOuts(runId) {
        return byRun(store.cashOuts, runId);
      },
      async listLinks(runId) {
        return byRun(store.links, runId);
      },
      async listChanges(runId) {
        return byRun(store.changes, runId);
      },
      async latestReport(runId, kind) {
        const found = store.reports.findLast((r) => r.runId === runId && r.kind === kind);
        return found
          ? { blobSha256: found.blobSha256, mediaType: found.mediaType, createdAt: found.createdAt }
          : undefined;
      },
    },
    labels: {
      async upsert(labels) {
        for (const label of labels) {
          store.labels.set(`${addressKey(label.address)}|${label.entity}|${label.provenance.datasetId}`, copy(label));
        }
      },
      async list() {
        return copy([...store.labels.values()]);
      },
    },
  };
}
