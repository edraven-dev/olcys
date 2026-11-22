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
  RoleCue,
  RunConfigSnapshot,
} from '@olcys/core';
import { ROLE_CUES } from '@olcys/core';
import { ADDRESS_ROLE_TASK } from '@olcys/llm';
import {
  applyOverrides,
  overridesAt,
  overridesVersion,
  type AnalystCue,
  type FeatureExtractionInput,
} from '@olcys/scoring';

type RunRef = Pick<AnalysisRun, 'id' | 'caseId' | 'trigger' | 'config'> &
  Partial<Pick<AnalysisRun, 'rescoreOfRunId' | 'queuedAt'>>;

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

/**
 * Role cues of the suggestions an analyst confirmed for the rescored run before this rescore was queued. Only a
 * confirmed suggestion is a cue (pending and rejected ones never are), and only a rescore applies it: a collecting run
 * never reads suggestions. The model's word alone never reaches the score.
 */
async function confirmedCues(repos: Repositories, run: RunRef): Promise<AnalystCue[]> {
  if (run.trigger !== 'rescore' || !run.rescoreOfRunId || !repos.llm) return [];
  const limit = run.queuedAt ? Date.parse(run.queuedAt) : Number.POSITIVE_INFINITY;
  return (await repos.llm.listSuggestionsByRun(run.rescoreOfRunId))
    .filter(
      (s) =>
        s.task === ADDRESS_ROLE_TASK &&
        s.status === 'confirmed' &&
        s.target.candidateId !== undefined &&
        ROLE_CUES.includes(s.label as RoleCue) &&
        (s.decidedAt === undefined || Date.parse(s.decidedAt) <= limit),
    )
    .map((s) => ({ candidateId: s.target.candidateId as Id, cue: s.label as RoleCue, suggestionId: s.id }));
}

/** The scoring input of a run with the analyst overrides it applies; `applied` counts them. */
export async function withAnalystOverrides(
  repos: Repositories,
  run: RunRef,
  input: FeatureExtractionInput,
  logger?: Logger,
): Promise<{ input: FeatureExtractionInput; applied: number }> {
  const overrides = await runOverrides(repos, run);
  const cues = await confirmedCues(repos, run);
  if (overrides.length === 0 && cues.length === 0) return { input, applied: 0 };
  const current = new Set(input.extractions.flatMap((e) => e.candidates.map((c) => c.id)));
  const named = await namedCandidates(repos, run.caseId, overrides, current);
  // The candidates the cues name were extracted by the rescored run: their ids are looked up again by position.
  const cued = new Set(cues.map((c) => c.candidateId));
  const earlier =
    cued.size > 0 && run.rescoreOfRunId
      ? (await repos.evidence.listCandidates(run.rescoreOfRunId)).filter((c) => cued.has(c.id))
      : [];
  logger?.info('analyst overrides applied', {
    runId: run.id,
    overrides: overrides.length,
    confirmedSuggestions: cues.length,
    version: overridesVersion(overrides),
  });
  return {
    input: applyOverrides(input, overrides, { candidates: [...named, ...earlier], cues }),
    applied: overrides.length,
  };
}
