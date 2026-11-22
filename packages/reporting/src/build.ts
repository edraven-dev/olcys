/**
 * Assembles `ReportData` for one run from the repository ports. Lists are sorted by stable keys, so the data (and
 * its SHA-256) does not depend on the storage order of the repository implementation.
 */
import type {
  AnalysisRepository,
  AnalysisRun,
  AnalystOverride,
  Capture,
  FlowEdge,
  Id,
  IsoDateTime,
  Repositories,
  RunWithProgress,
  SourceDescriptor,
} from '@olcys/core';
import { addressKey, newId, nowIso, readPartialReasons } from '@olcys/core';
import { REPORT_TEMPLATE_VERSION, type ReportData, type ReportSource } from './types.ts';
import { cmp, refKey, timeOf } from './view.ts';

export interface BuildReportOptions {
  /** Source register (`config/sources.yaml`) for display names and compliance status. */
  sources?: readonly SourceDescriptor[];
  /** Calibration status of the weights file, e.g. `uncalibrated`. */
  weightsStatus?: string;
  generatedAt?: IsoDateTime;
  reportId?: Id;
  /**
   * The run whose collected evidence and chain analysis the report shows (for a rescore: the rescored run); default the
   * run itself. Candidates, links and changes always belong to the run.
   */
  evidenceRunId?: Id;
}

/** Optional port extension: fund-flow edges, when the analytics store keeps them. */
type FlowListing = { listFlows?: (runId: Id) => Promise<FlowEdge[]> };

function plainRun(run: RunWithProgress): AnalysisRun {
  const { progress: _progress, error: _error, ...rest } = run;
  return rest;
}

const byId = <T extends { id: string }>(items: readonly T[]): T[] => items.toSorted((a, b) => cmp(a.id, b.id));
const byTime = <T extends { at: string; id: string }>(items: readonly T[]): T[] =>
  items.toSorted((a, b) => timeOf(a.at) - timeOf(b.at) || cmp(a.id, b.id));

/** The overrides a run applied: only a rescore applies them — exactly the set its config snapshot fixed when queued. */
function appliedOverrides(run: AnalysisRun, overrides: readonly AnalystOverride[]): AnalystOverride[] {
  const ids = new Set(run.trigger === 'rescore' ? (run.config.analystOverrides ?? []) : []);
  return byTime(overrides.filter((o) => ids.has(o.id)));
}

function toReportSource(s: SourceDescriptor): ReportSource {
  return {
    id: s.id,
    name: s.namePl ?? s.name,
    kind: s.kind,
    compliance: s.compliance,
    reliability: s.reliability,
    sendsIdentifiersExternally: s.sendsIdentifiersExternally,
  };
}

export async function buildReportData(
  repos: Repositories,
  runId: Id,
  options: BuildReportOptions = {},
): Promise<ReportData> {
  const evidenceRunId = options.evidenceRunId ?? runId;
  const run = await repos.runs.get(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const kase = await repos.cases.get(run.caseId);
  if (!kase) throw new Error(`case ${run.caseId} not found`);

  const analysis = repos.analysis as AnalysisRepository & FlowListing;
  const [
    captures,
    accounts,
    observations,
    candidates,
    extractions,
    egress,
    transfers,
    links,
    exclusions,
    activity,
    cashOuts,
    changes,
    labels,
    flows,
    addressTypes,
    clusters,
  ] = await Promise.all([
    repos.evidence.listCaptures(evidenceRunId),
    repos.evidence.listAccounts(evidenceRunId),
    repos.evidence.listObservations(evidenceRunId),
    repos.evidence.listCandidates(runId),
    repos.evidence.listExtractionResults(runId),
    repos.evidence.listEgressLog(evidenceRunId),
    repos.chain.listTransfers(evidenceRunId),
    analysis.listLinks(runId),
    analysis.listExclusions(evidenceRunId),
    analysis.listActivity(evidenceRunId),
    analysis.listCashOuts(evidenceRunId),
    analysis.listChanges(runId),
    repos.labels.list(),
    analysis.listFlows ? analysis.listFlows(evidenceRunId) : Promise.resolve([] as FlowEdge[]),
    repos.addressTypes ? repos.addressTypes.list(evidenceRunId) : Promise.resolve([]),
    repos.clusters ? repos.clusters.list(evidenceRunId) : Promise.resolve([]),
  ]);

  // Analyst statements and inputs, kept apart from the computed results (optional ports of the store).
  const [judgements, overrides, suggestions] = await Promise.all([
    repos.judgements ? repos.judgements.listByRun(runId) : Promise.resolve([]),
    repos.overrides && run.trigger === 'rescore' && run.config.analystOverrides?.length
      ? repos.overrides.listByCase(run.caseId)
      : Promise.resolve([]),
    repos.llm ? repos.llm.listSuggestionsByRun(runId) : Promise.resolve([]),
  ]);
  // Address-mention roles proposed by the model: hypotheses of zero weight, listed with their status.
  const roleSuggestions = suggestions
    .filter((x) => x.task === 'address-role-classification')
    .toSorted((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const applied = appliedOverrides(plainRun(run), overrides);

  // Reasons the pipeline recorded so far (`markPartial`): sources or stages that could not deliver data.
  const reasons = readPartialReasons(run.progress);
  const partialReasons = reasons.map((r) => r.text);
  const partialCodes = reasons.filter((r) => r.code !== undefined);
  const previousRunId = run.previousRunId ?? changes[0]?.previousRunId;
  const previous = previousRunId ? await repos.runs.get(previousRunId) : undefined;

  // The "before" side of a change was captured by an earlier run.
  const own = new Set(captures.map((c) => c.id));
  const cited = [
    ...new Set(changes.flatMap((c) => [c.beforeCaptureId, c.afterCaptureId]).filter((id): id is Id => !!id)),
  ].filter((id) => !own.has(id));
  const earlier = (await Promise.all(cited.map((id) => repos.evidence.getCapture(id)))).filter(
    (c): c is Capture => c !== undefined,
  );

  // Reference labels are global: keep those of addresses this run touched.
  const relevant = new Set(
    [
      ...links.map((l) => l.address),
      ...exclusions.map((e) => e.address),
      ...candidates.map((c) => c.address),
      ...transfers.flatMap((t) => [
        { chain: t.chain, address: t.from },
        { chain: t.chain, address: t.to },
      ]),
      ...cashOuts.flatMap((e) => [e.address, { chain: e.address.chain, address: e.counterparty?.address ?? '' }]),
      ...activity.map((a) => a.address),
      ...flows.flatMap((f) => [f.from, f.to]),
    ].map(refKey),
  );
  // Labels cited by decisions and the labels of services spent together with a cluster (found in expanded histories).
  const labelIds = new Set([
    ...exclusions.flatMap((e) => e.evidence?.labelIds ?? []),
    ...clusters.flatMap((c) => c.serviceMembers.map((s) => s.labelId)),
  ]);
  const usedSources = new Set([
    ...captures.map((c) => c.sourceId),
    ...egress.map((e) => e.sourceId),
    ...(kase.scope?.enabledSources ?? []),
  ]);

  return {
    reportId: options.reportId ?? newId(),
    generatedAt: options.generatedAt ?? nowIso(),
    templateVersion: REPORT_TEMPLATE_VERSION,
    case: kase,
    run: plainRun(run),
    ...(previous ? { previousRun: plainRun(previous) } : {}),
    ...(options.weightsStatus ? { weightsStatus: options.weightsStatus } : {}),
    ...(partialReasons.length ? { partialReasons } : {}),
    ...(partialCodes.length ? { partialCodes } : {}),
    sources: (options.sources ?? [])
      .filter((s) => usedSources.has(s.id))
      .map(toReportSource)
      .toSorted((a, b) => cmp(a.id, b.id)),
    captures: byId(captures),
    earlierCaptures: byId(earlier),
    accounts: byId(accounts),
    observations: byId(observations),
    candidates: byId(candidates),
    rejectedCandidates: extractions
      .toSorted((a, b) => cmp(a.captureId, b.captureId))
      .flatMap((r) =>
        (r.rejected ?? []).map((x) => ({ captureId: r.captureId, raw: x.raw, reason: x.reason, view: x.view })),
      ),
    secretFindings: extractions.reduce((n, r) => n + (r.secrets?.length ?? 0), 0),
    egress: egress.toSorted((a, b) => cmp(a.at, b.at) || cmp(a.id, b.id)),
    transfers: transfers.toSorted(
      (a, b) =>
        cmp(a.chain, b.chain) ||
        cmp(a.txHash, b.txHash) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        cmp(a.from, b.from) ||
        cmp(a.to, b.to),
    ),
    flows: flows.toSorted(
      (a, b) =>
        cmp(a.txHash, b.txHash) ||
        cmp(addressKey(a.from), addressKey(b.from)) ||
        cmp(addressKey(a.to), addressKey(b.to)),
    ),
    links: byId(links),
    exclusions: byId(exclusions),
    ...(addressTypes.length
      ? { addressTypes: addressTypes.toSorted((a, b) => cmp(addressKey(a.address), addressKey(b.address))) }
      : {}),
    ...(clusters.length ? { clusters: clusters.toSorted((a, b) => cmp(a.id, b.id)) } : {}),
    labels: byId(labels.filter((l) => relevant.has(refKey(l.address)) || labelIds.has(l.id))),
    activity: activity.toSorted((a, b) => cmp(addressKey(a.address), addressKey(b.address))),
    cashOuts: byId(cashOuts),
    changes: byId(changes),
    ...(judgements.length ? { judgements: byTime(judgements) } : {}),
    ...(roleSuggestions.length ? { suggestions: roleSuggestions } : {}),
    ...(applied.length ? { overrides: applied } : {}),
  };
}
