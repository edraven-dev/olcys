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
  ConfirmedSuggestionRef,
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
 * The config snapshot of a new run. A rescore fixes what it applies when it is queued: the overrides recorded until
 * then (their ids as `analystOverrides`, labelled `rulesVersions.overrides = overrides@<count>:<last id>`) and the
 * role suggestions an analyst confirmed until then (`confirmedSuggestions`, labelled `rulesVersions.confirmedSuggestions`).
 */
export async function withOverridesSnapshot(
  repos: Repositories,
  run: Pick<AnalysisRun, 'caseId' | 'trigger' | 'queuedAt' | 'rescoreOfRunId'>,
  config: RunConfigSnapshot,
): Promise<RunConfigSnapshot> {
  if (run.trigger !== 'rescore') return config;
  let next = config;
  if (repos.overrides) {
    const overrides = overridesAt(await repos.overrides.listByCase(run.caseId), run.queuedAt);
    next = {
      ...next,
      rulesVersions: { ...next.rulesVersions, overrides: overridesVersion(overrides) },
      analystOverrides: overrides.map((o) => o.id),
    };
  }
  const confirmed = await confirmedSuggestionRefs(repos, run);
  if (confirmed.length > 0) {
    next = {
      ...next,
      rulesVersions: { ...next.rulesVersions, confirmedSuggestions: `suggestions@${confirmed.length}` },
      confirmedSuggestions: confirmed,
    };
  }
  return next;
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
 * The role suggestions an analyst confirmed for the rescored run until the rescore was queued. Only a confirmed
 * suggestion qualifies (pending and rejected ones never do). Called when the rescore is created; the result is stored
 * in its config snapshot, so a later decision never changes that rescore.
 */
async function confirmedSuggestionRefs(
  repos: Repositories,
  run: Pick<AnalysisRun, 'trigger' | 'queuedAt' | 'rescoreOfRunId'>,
): Promise<ConfirmedSuggestionRef[]> {
  if (run.trigger !== 'rescore' || !run.rescoreOfRunId || !repos.llm) return [];
  const limit = Date.parse(run.queuedAt);
  const confirmed = (await repos.llm.listSuggestionsByRun(run.rescoreOfRunId)).filter(
    (s) =>
      s.task === ADDRESS_ROLE_TASK &&
      s.status === 'confirmed' &&
      s.target.candidateId !== undefined &&
      ROLE_CUES.includes(s.label as RoleCue) &&
      s.decidedAt !== undefined &&
      Date.parse(s.decidedAt) <= limit,
  );
  if (confirmed.length === 0) return [];
  const candidates = new Map((await repos.evidence.listCandidates(run.rescoreOfRunId)).map((c) => [c.id, c]));
  return confirmed.map((s) => {
    const candidateId = s.target.candidateId as Id;
    const address = candidates.get(candidateId)?.address;
    const ref: ConfirmedSuggestionRef = {
      suggestionId: s.id,
      decidedAt: s.decidedAt as string,
      role: s.label,
      candidateId,
    };
    if (address) ref.address = address;
    return ref;
  });
}

/** The cues a rescore applies: exactly the confirmed suggestions its config snapshot lists. */
const cuesOf = (run: RunRef): AnalystCue[] =>
  run.trigger !== 'rescore'
    ? []
    : (run.config.confirmedSuggestions ?? []).map((c) => ({
        candidateId: c.candidateId,
        cue: c.role as RoleCue,
        suggestionId: c.suggestionId,
      }));

/** The scoring input of a run with the analyst overrides it applies; `applied` counts them. */
export async function withAnalystOverrides(
  repos: Repositories,
  run: RunRef,
  input: FeatureExtractionInput,
  logger?: Logger,
): Promise<{ input: FeatureExtractionInput; applied: number }> {
  const overrides = await runOverrides(repos, run);
  const cues = cuesOf(run);
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
