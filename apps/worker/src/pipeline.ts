/**
 * The MVP's synchronous analysis pipeline: stages run in order inside one process, report progress on the run
 * record and persist their own results through the repository ports. The comparison against the previous completed
 * run of the case is built in at the `diff.previous` step; stages of later steps (the report) run after it. A later
 * version replaces the loop with per-step jobs; stages stay the same.
 */
import type {
  AnalysisRun,
  BlobStore,
  CaseWithIdentifiers,
  ChangeEvent,
  FetchMode,
  Id,
  Logger,
  PartialCode,
  PartialParams,
  PartialReason,
  Repositories,
  RunConfigSnapshot,
  RunStep,
  RunWithProgress,
} from '@olcys/core';
import { newId, nowIso, partialProgress, readPartialReasons, RUN_STEPS } from '@olcys/core';
import { diffRuns, type RunSnapshot } from '@olcys/evidence';
import { withOverridesSnapshot } from './analyst.ts';

export interface StageContext {
  run: RunWithProgress;
  /**
   * The run whose collected evidence this run analyses: the run itself, or for a rescore the rescored run. A rescore
   * never collects; it re-extracts and re-scores the saved evidence, so its changes isolate algorithm changes.
   */
  evidenceRunId: Id;
  case: CaseWithIdentifiers;
  repos: Repositories;
  blobs: BlobStore;
  logger: Logger;
  /** Detail for the UI (counts, current source); merged into the run's progress record. */
  progress(detail: Record<string, unknown>): Promise<void>;
  /**
   * Some data could not be read or computed (blocked source, incomplete chain history, no valuation): the run ends as
   * `partial`. `reason` is an English sentence for logs; `coded` gives the stable code and parameters from which the
   * UI and the report render Polish text.
   */
  markPartial(reason: string, coded?: { code: PartialCode; params?: PartialParams }): void;
}

export interface Stage {
  step: RunStep;
  run(ctx: StageContext): Promise<void>;
}

export interface PipelineDeps {
  repos: Repositories;
  blobs: BlobStore;
  logger: Logger;
  stages: readonly Stage[];
}

export interface StartRunInput {
  caseId: Id;
  mode: FetchMode;
  trigger?: AnalysisRun['trigger'];
  rescoreOfRunId?: Id;
}

/** Creates a queued run with the configuration snapshot; the caller runs the pipeline. */
export async function createRun(
  repos: Repositories,
  input: StartRunInput,
  config: RunConfigSnapshot,
): Promise<AnalysisRun> {
  // A rescore compares with the run it rescores (same evidence); other runs with the latest completed one.
  const target = input.rescoreOfRunId ? await repos.runs.get(input.rescoreOfRunId) : undefined;
  if (input.rescoreOfRunId && !target) throw new Error(`rescore target ${input.rescoreOfRunId} not found`);
  const previous = target ?? (await repos.runs.latestCompleted(input.caseId));
  // `rescoreOfRunId` names the run that collected the evidence, also when a rescore is rescored again.
  const evidenceRunId = target ? evidenceRunIdOf(target) : undefined;
  const trigger = input.trigger ?? 'manual';
  const queuedAt = nowIso();
  const run: AnalysisRun = {
    id: newId(),
    caseId: input.caseId,
    ...(previous ? { previousRunId: previous.id } : {}),
    trigger,
    ...(evidenceRunId ? { rescoreOfRunId: evidenceRunId } : {}),
    mode: input.mode,
    status: 'queued',
    // A rescore fixes the analyst overrides it applies (those recorded until it was queued).
    config: await withOverridesSnapshot(repos, { caseId: input.caseId, trigger, queuedAt }, config),
    queuedAt,
  };
  await repos.runs.create(run);
  return run;
}

/** The run whose collected evidence `run` analyses (itself, or the rescored run). */
export function evidenceRunIdOf(run: Pick<AnalysisRun, 'id' | 'trigger' | 'rescoreOfRunId'>): Id {
  return run.trigger === 'rescore' && run.rescoreOfRunId ? run.rescoreOfRunId : run.id;
}

async function snapshotOf(repos: Repositories, run: RunWithProgress): Promise<RunSnapshot> {
  const evidenceRunId = evidenceRunIdOf(run);
  const [captures, observations, assessments] = await Promise.all([
    repos.evidence.listCaptures(evidenceRunId),
    repos.evidence.listObservations(evidenceRunId),
    repos.analysis.listLinks(run.id),
  ]);
  return {
    runId: run.id,
    algorithm: {
      algorithmVersion: assessments[0]?.algorithmVersion ?? 'none',
      weightsVersion: run.config.weightsVersion,
    },
    captures,
    observations,
    assessments,
  };
}

/**
 * Compares the run with the predecessor recorded when it was created (`previousRunId`) and stores the change events.
 * Using the recorded predecessor keeps the direction stable when runs of one case overlap.
 */
export async function diffWithPrevious(repos: Repositories, run: RunWithProgress): Promise<ChangeEvent[]> {
  if (!run.previousRunId) return [];
  const previous = await repos.runs.get(run.previousRunId);
  if (!previous) return [];
  const { events } = diffRuns(await snapshotOf(repos, previous), await snapshotOf(repos, run));
  const detectedAt = nowIso();
  const changes: ChangeEvent[] = events.map((e) => Object.assign({}, e, { id: newId(), detectedAt }));
  if (changes.length) await repos.analysis.addChanges(changes);
  return changes;
}

/**
 * Places the built-in comparison step by `RUN_STEPS` order: stages of later steps (the report) run after it and
 * see the change events of this run.
 */
function orderWithDiff(stages: readonly Stage[], diff: Stage): Stage[] {
  const at = RUN_STEPS.indexOf('diff.previous');
  return [
    ...stages.filter((s) => RUN_STEPS.indexOf(s.step) <= at),
    diff,
    ...stages.filter((s) => RUN_STEPS.indexOf(s.step) > at),
  ];
}

export async function runPipeline(runId: Id, deps: PipelineDeps): Promise<RunWithProgress> {
  const { repos, logger } = deps;
  const queued = await repos.runs.get(runId);
  if (!queued) throw new Error(`run ${runId} not found`);

  const partial: PartialReason[] = [];
  let changes: ChangeEvent[] = [];
  let total = 0;
  let progress: Record<string, unknown> = { step: 'run.start', done: 0, total };
  try {
    // Everything from here on ends the run as `failed` when it throws: a run never stays `queued` or `running`.
    const kase = await repos.cases.get(queued.caseId);
    if (!kase) throw new Error(`case ${queued.caseId} not found`);
    const stages = orderWithDiff(deps.stages, {
      step: 'diff.previous',
      async run(stageCtx) {
        changes = await diffWithPrevious(repos, stageCtx.run);
      },
    });
    total = stages.length;
    progress = { step: 'run.start', done: 0, total };
    const evidenceRunId = evidenceRunIdOf(queued);
    // A rescore re-analyses saved evidence: whatever that evidence lacked is still missing from the new analysis.
    if (evidenceRunId !== runId) partial.push(...readPartialReasons((await repos.runs.get(evidenceRunId))?.progress));
    await repos.runs.update(runId, { status: 'running', startedAt: nowIso(), progress });
    const ctx: StageContext = {
      run: { ...queued, status: 'running' },
      evidenceRunId,
      case: kase,
      repos,
      blobs: deps.blobs,
      logger,
      async progress(detail) {
        progress = { ...progress, ...detail };
        await repos.runs.update(runId, { progress });
      },
      markPartial(reason, coded) {
        partial.push({ text: reason, ...coded });
      },
    };

    for (const [index, stage] of stages.entries()) {
      // Reasons recorded so far stay visible to later stages (the report states that the analysis is incomplete).
      progress = { step: stage.step, done: index, total, ...partialProgress(partial) };
      // Sequential on purpose: every stage consumes what the previous stages stored.
      // oxlint-disable-next-line no-await-in-loop
      await repos.runs.update(runId, { progress });
      // oxlint-disable-next-line no-await-in-loop
      await stage.run(ctx);
    }
    await repos.runs.update(runId, {
      status: partial.length ? 'partial' : 'succeeded',
      finishedAt: nowIso(),
      progress: { step: 'run.finish', done: total, total, changes: changes.length, ...partialProgress(partial) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('run failed', { runId, error: message });
    await repos.runs.update(runId, { status: 'failed', finishedAt: nowIso(), error: message });
  }
  const finished = await repos.runs.get(runId);
  if (!finished) throw new Error(`run ${runId} disappeared`);
  return finished;
}
