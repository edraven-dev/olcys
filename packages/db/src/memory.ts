/**
 * In-memory implementation of the repository ports — same contracts as the SQL implementation, for tests and
 * database-less demos. Append-only like the store it mirrors: only run lifecycle fields and case schedules change.
 */
import type {
  ActivityIndicators,
  AddressLabel,
  AnalystJudgement,
  AnalystOverride,
  CustodyEvent,
  LlmCallRecord,
  LlmSuggestion,
  LlmSuggestionDecision,
  NewLlmSuggestion,
  CashOutEvent,
  ChangeEvent,
  CaseWithIdentifiers,
  ExclusionDecision,
  FlowEdge,
  FundFlowView,
  Id,
  LinkAssessment,
  NormalizedTransfer,
  Repositories,
  RunWithProgress,
} from '@olcys/core';
import { addressKey, newId, nowIso, traceFlows, uniqueTransfers } from '@olcys/core';
import { memoryClusterRepository } from './memory-clusters.ts';
import { memoryAddressTypeRepository } from './memory-address-types.ts';
import { memoryScheduleRepository } from './memory-schedules.ts';
import { memoryTimestamps } from './memory-timestamps.ts';
import { labelContentSha256 } from './sql/analysis.ts';

const copy = <T>(value: T): T => structuredClone(value);
const byRun = <T extends { runId?: Id }>(items: readonly T[], runId: Id): T[] =>
  copy(items.filter((i) => i.runId === runId));
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Oldest first by (`at`, `id`), as the SQL implementation orders analyst records. */
const chronological = <T extends { at: string; id: Id }>(items: readonly T[]): T[] =>
  copy(items.toSorted((a, b) => text(a.at, b.at) || text(a.id, b.id)));

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
    transfers: [] as { runId: Id; transfer: NormalizedTransfer; expansionHop: number }[],
    flows: [] as { runId: Id; key: string; edge: FlowEdge }[],
    flowViews: [] as FundFlowView[],
    exclusions: [] as ExclusionDecision[],
    activity: [] as { runId: Id; indicators: ActivityIndicators }[],
    cashOuts: [] as CashOutEvent[],
    links: [] as LinkAssessment[],
    changes: [] as ChangeEvent[],
    reports: [] as { runId: Id; kind: string; blobSha256: string; mediaType: string; createdAt: string }[],
    /** Label versions, as in SQL: exact re-imports are no-ops, a corrected record is a new version. */
    labels: [] as { key: string; sha: string; lastmod: string; label: AddressLabel }[],
    judgements: [] as AnalystJudgement[],
    overrides: [] as AnalystOverride[],
    custody: [] as CustodyEvent[],
    llmCalls: [] as LlmCallRecord[],
    suggestions: [] as NewLlmSuggestion[],
    decisions: [] as LlmSuggestionDecision[],
  };

  const withDecision = (s: NewLlmSuggestion): LlmSuggestion => {
    const d = store.decisions.find((x) => x.suggestionId === s.id);
    if (!d) return copy({ ...s, status: 'pending' as const });
    return copy({
      ...s,
      status: d.decision,
      decidedBy: d.decidedBy,
      decidedAt: d.decidedAt,
      justification: d.justification,
      ...(d.editedText ? { editedText: d.editedText } : {}),
    });
  };

  const timestamps = memoryTimestamps(store.custody);

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
          scope: copy(input.scope),
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
    schedules: memoryScheduleRepository(cases, runs),
    addressTypes: memoryAddressTypeRepository(runs),
    clusters: memoryClusterRepository(runs),
    evidence: {
      async addEgressLog(entries) {
        store.egress.push(...copy(entries));
      },
      async addRawFetches(envelopes) {
        store.fetches.push(...copy(envelopes));
      },
      async addCaptures(captures, custodyEvents) {
        store.captures.push(...copy(captures));
        if (custodyEvents) store.custody.push(...copy(custodyEvents));
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
      async addExtractions(runId, results) {
        // Copy everything first: a failure part-way stores nothing.
        const copies = results.map((result) => ({ runId, result: copy(result) }));
        store.extractions.push(...copies);
      },
      async listEgressLog(runId) {
        return byRun(store.egress, runId);
      },
      async listCaptures(runId) {
        return timestamps.attach(byRun(store.captures, runId));
      },
      async getCapture(id) {
        const found = store.captures.find((c) => c.id === id);
        return found ? timestamps.attach([copy(found)])[0] : undefined;
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
      async addTransfers(runId, _address, transfers, options) {
        const expansionHop = options?.expansionHop ?? 0;
        store.transfers.push(...transfers.map((transfer) => ({ runId, transfer: copy(transfer), expansionHop })));
      },
      async listTransfers(runId) {
        // A transfer between two analysed addresses is stored under both; the run has it once.
        return copy(
          uniqueTransfers(
            store.transfers.filter((t) => t.runId === runId && t.expansionHop === 0).map((t) => t.transfer),
          ),
        );
      },
      async queryFlowEdges(runId, query) {
        return copy(
          await traceFlows(
            store.transfers.filter((t) => t.runId === runId).map((t) => t.transfer),
            query,
          ),
        );
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
      async getLink(id) {
        const found = store.links.find((l) => l.id === id);
        return found ? copy(found) : undefined;
      },
      async listChanges(runId) {
        return byRun(store.changes, runId);
      },
      async addFlows(runId, edges) {
        for (const edge of edges) {
          const key = [
            edge.from.chain,
            edge.txHash,
            edge.index ?? -1,
            edge.from.address,
            edge.to.address,
            edge.asset,
            edge.hop,
          ].join('|');
          // The same transfer at the same hop is one edge of the run, as the primary key of the SQL table.
          if (store.flows.some((f) => f.runId === runId && f.key === key)) continue;
          store.flows.push({ runId, key, edge: copy(edge) });
        }
      },
      async listFlows(runId) {
        return copy(
          store.flows
            .filter((f) => f.runId === runId)
            .map((f) => f.edge)
            .toSorted(
              (a, b) =>
                Math.abs(a.hop) - Math.abs(b.hop) ||
                Date.parse(a.at) - Date.parse(b.at) ||
                text(a.txHash, b.txHash) ||
                (a.index ?? -1) - (b.index ?? -1) ||
                a.hop - b.hop,
            ),
        );
      },
      async addFlowViews(views) {
        for (const view of views) {
          if (
            store.flowViews.some((v) => v.runId === view.runId && addressKey(v.address) === addressKey(view.address))
          ) {
            continue;
          }
          store.flowViews.push(copy(view));
        }
      },
      async listFlowViews(runId) {
        return copy(
          store.flowViews
            .filter((v) => v.runId === runId)
            .toSorted((a, b) => text(addressKey(a.address), addressKey(b.address))),
        );
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
          const key = `${addressKey(label.address)}|${label.entity}|${label.provenance.datasetId}`;
          const sha = labelContentSha256(label);
          if (store.labels.some((v) => v.key === key && v.sha === sha)) continue;
          store.labels.push({ key, sha, lastmod: label.provenance.lastmod, label: copy(label) });
        }
      },
      /** Current labels: the newest version (by `lastmod`, then insertion) per address, entity and dataset. */
      async list() {
        const current = new Map<string, { lastmod: string; label: AddressLabel }>();
        for (const v of store.labels) {
          const seen = current.get(v.key);
          if (!seen || v.lastmod >= seen.lastmod) current.set(v.key, v);
        }
        return copy([...current.values()].map((v) => v.label));
      },
    },
    // Analyst records reference a stored link or case, like the foreign keys of the SQL tables.
    judgements: {
      async add(judgement) {
        if (!store.links.some((l) => l.id === judgement.linkAssessmentId)) {
          throw new Error(`link ${judgement.linkAssessmentId} not found`);
        }
        store.judgements.push(copy(judgement));
      },
      async listByLink(linkAssessmentId) {
        return chronological(store.judgements.filter((j) => j.linkAssessmentId === linkAssessmentId));
      },
      async listByRun(runId) {
        const links = new Set(store.links.filter((l) => l.runId === runId).map((l) => l.id));
        return chronological(store.judgements.filter((j) => links.has(j.linkAssessmentId)));
      },
    },
    overrides: {
      async add(override) {
        if (!cases.has(override.caseId)) throw new Error(`case ${override.caseId} not found`);
        store.overrides.push(copy(override));
      },
      async listByCase(caseId) {
        return chronological(store.overrides.filter((o) => o.caseId === caseId));
      },
    },
    custody: {
      async add(events) {
        store.custody.push(...events.map((e) => copy(e)));
      },
      async listBySubjects(subjectIds) {
        const wanted = new Set(subjectIds);
        return chronological(store.custody.filter((e) => wanted.has(e.subject.id)));
      },
    },
    timestamps: timestamps.repository,
    llm: {
      async addCall(record) {
        store.llmCalls.push(copy(record));
      },
      async addSuggestions(suggestions) {
        store.suggestions.push(...suggestions.map((s) => copy(s)));
      },
      async getSuggestion(id) {
        const found = store.suggestions.find((s) => s.id === id);
        return found ? withDecision(found) : undefined;
      },
      async listSuggestionsByRun(runId) {
        return store.suggestions
          .filter((s) => s.runId === runId)
          .toSorted((a, b) => text(a.createdAt, b.createdAt) || text(a.id, b.id))
          .map(withDecision);
      },
      async decide(decision) {
        if (store.decisions.some((d) => d.suggestionId === decision.suggestionId)) return false;
        store.decisions.push(copy(decision));
        return true;
      },
    },
  };
}
