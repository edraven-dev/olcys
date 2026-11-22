/**
 * Analyst overrides in the pipeline. Only a rescore run applies them: the overrides of the case recorded up to the
 * time the run was queued, named in the run's config snapshot (`rulesVersions.overrides`). Collecting runs score the
 * evidence as collected, and no run ever changes an assessment stored earlier.
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

type RunRef = Pick<AnalysisRun, 'id' | 'caseId' | 'trigger' | 'queuedAt'>;

/** The overrides a run applies: none unless it is a rescore. */
export async function runOverrides(repos: Repositories, run: Omit<RunRef, 'id'>): Promise<AnalystOverride[]> {
  if (run.trigger !== 'rescore' || !repos.overrides) return [];
  return overridesAt(await repos.overrides.listByCase(run.caseId), run.queuedAt);
}

/** The config snapshot of a new run; a rescore's names the overrides it applies (`overrides@<count>:<last id>`). */
export async function withOverridesVersion(
  repos: Repositories,
  run: Omit<RunRef, 'id'>,
  config: RunConfigSnapshot,
): Promise<RunConfigSnapshot> {
  if (run.trigger !== 'rescore' || !repos.overrides) return config;
  const overrides = await runOverrides(repos, run);
  return { ...config, rulesVersions: { ...config.rulesVersions, overrides: overridesVersion(overrides) } };
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
