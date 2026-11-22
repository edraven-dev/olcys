/**
 * Analyst overrides in the pipeline. Only a rescore run applies them: the overrides of the case recorded up to the
 * time the run was queued. That set is fixed when the run is created — its ids are stored in the run's config snapshot
 * (`analystOverrides`, labelled by `rulesVersions.overrides`) — and scoring applies exactly that set, so an override
 * stored later never changes a queued run. Collecting runs score the evidence as collected, and no run ever changes
 * an assessment stored earlier.
 */
import type {
  AddressCandidate,
  AnalysisRun,
  AnalystOverride,
  Id,
  Logger,
  Repositories,
  RunConfigSnapshot,
} from '@olcys/core';
import { applyOverrides, overridesAt, overridesVersion, type FeatureExtractionInput } from '@olcys/scoring';

type RunRef = Pick<AnalysisRun, 'id' | 'caseId' | 'trigger' | 'config'>;

/**
 * The config snapshot of a new run. A rescore fixes the overrides it applies — those recorded until it was queued —
 * as their ids (`analystOverrides`) and a label (`rulesVersions.overrides = overrides@<count>:<last id>`).
 */
export async function withOverridesSnapshot(
  repos: Repositories,
  run: Pick<AnalysisRun, 'caseId' | 'trigger' | 'queuedAt'>,
  config: RunConfigSnapshot,
): Promise<RunConfigSnapshot> {
  if (run.trigger !== 'rescore' || !repos.overrides) return config;
  const overrides = overridesAt(await repos.overrides.listByCase(run.caseId), run.queuedAt);
  return {
    ...config,
    rulesVersions: { ...config.rulesVersions, overrides: overridesVersion(overrides) },
    analystOverrides: overrides.map((o) => o.id),
  };
}

/**
 * The overrides a run applies: exactly the set its config snapshot fixed when it was queued (rescores only), never a
 * fresh selection. A recorded override that cannot be found is an error, not a silently different result.
 */
export async function runOverrides(repos: Repositories, run: RunRef): Promise<AnalystOverride[]> {
  const ids = run.trigger === 'rescore' ? (run.config.analystOverrides ?? []) : [];
  if (ids.length === 0) return [];
  if (!repos.overrides) throw new Error(`run ${run.id} applies analyst overrides, but the store keeps none`);
  const stored = new Map((await repos.overrides.listByCase(run.caseId)).map((o) => [o.id, o]));
  return ids.map((id) => {
    const found = stored.get(id);
    if (!found) throw new Error(`analyst override ${id} recorded for run ${run.id} not found`);
    return found;
  });
}

/**
 * The stored candidates the overrides name that this run's extraction does not contain (a rescore re-extracts the
 * saved captures under new ids): looked up in every run of the case, so the scorer can find them again.
 */
async function namedCandidates(
  repos: Repositories,
  caseId: Id,
  overrides: readonly AnalystOverride[],
  current: ReadonlySet<Id>,
): Promise<AddressCandidate[]> {
  const wanted = new Set(
    overrides.flatMap((o) =>
      o.target.candidateId && !current.has(o.target.candidateId) ? [o.target.candidateId] : [],
    ),
  );
  if (wanted.size === 0) return [];
  const runs = await repos.runs.listByCase(caseId);
  const lists = await Promise.all(runs.map((r) => repos.evidence.listCandidates(r.id)));
  return lists.flat().filter((c) => wanted.has(c.id));
}

/** The scoring input of a run with the analyst overrides it applies; `applied` counts them. */
export async function withAnalystOverrides(
  repos: Repositories,
  run: RunRef,
  input: FeatureExtractionInput,
  logger?: Logger,
): Promise<{ input: FeatureExtractionInput; applied: number }> {
  const overrides = await runOverrides(repos, run);
  if (overrides.length === 0) return { input, applied: 0 };
  const current = new Set(input.extractions.flatMap((e) => e.candidates.map((c) => c.id)));
  const candidates = await namedCandidates(repos, run.caseId, overrides, current);
  logger?.info('analyst overrides applied', {
    runId: run.id,
    overrides: overrides.length,
    version: overridesVersion(overrides),
  });
  return { input: applyOverrides(input, overrides, { candidates }), applied: overrides.length };
}
