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
  Repositories,
  RunConfigSnapshot,
  RunStep,
  RunWithProgress,
} from '@olcys/core';
import { newId, nowIso, RUN_STEPS } from '@olcys/core';
import { diffRuns, type RunSnapshot } from '@olcys/evidence';

export interface StageContext {
  run: RunWithProgress;
  case: CaseWithIdentifiers;
  repos: Repositories;
  blobs: BlobStore;
  logger: Logger;
  /** Detail for the UI (counts, current source); merged into the run's progress record. */
  progress(detail: Record<string, unknown>): Promise<void>;
  /** Some sources could not be read (blocked, login wall, CAPTCHA, error): the run ends as `partial`. */
  markPartial(reason: string): void;
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
  const previous = await repos.runs.latestCompleted(input.caseId);
  const run: AnalysisRun = {
    id: newId(),
    caseId: input.caseId,
    ...(previous ? { previousRunId: previous.id } : {}),
    trigger: input.trigger ?? 'manual',
    ...(input.rescoreOfRunId ? { rescoreOfRunId: input.rescoreOfRunId } : {}),
    mode: input.mode,
    status: 'queued',
    config,
    queuedAt: nowIso(),
  };
  await repos.runs.create(run);
  return run;
}

async function snapshotOf(repos: Repositories, run: RunWithProgress): Promise<RunSnapshot> {
  const [captures, observations, assessments] = await Promise.all([
    repos.evidence.listCaptures(run.id),
    repos.evidence.listObservations(run.id),
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

/** Compares the run with the previous completed run of the case and stores the change events. */
export async function diffWithPrevious(repos: Repositories, run: RunWithProgress): Promise<ChangeEvent[]> {
  const previous = await repos.runs.latestCompleted(run.caseId, run.id);
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
  const kase = await repos.cases.get(queued.caseId);
  if (!kase) throw new Error(`case ${queued.caseId} not found`);

  let changes: ChangeEvent[] = [];
  const stages = orderWithDiff(deps.stages, {
    step: 'diff.previous',
    async run(stageCtx) {
      changes = await diffWithPrevious(repos, stageCtx.run);
    },
  });
  const total = stages.length;
  let progress: Record<string, unknown> = { step: 'run.start', done: 0, total };
  const partial: string[] = [];
  await repos.runs.update(runId, { status: 'running', startedAt: nowIso(), progress });
  const ctx: StageContext = {
    run: { ...queued, status: 'running' },
    case: kase,
    repos,
    blobs: deps.blobs,
    logger,
    async progress(detail) {
      progress = { ...progress, ...detail };
      await repos.runs.update(runId, { progress });
    },
    markPartial(reason) {
      partial.push(reason);
    },
  };

  try {
    for (const [index, stage] of stages.entries()) {
      progress = { step: stage.step, done: index, total };
      // Sequential on purpose: every stage consumes what the previous stages stored.
      // oxlint-disable-next-line no-await-in-loop
      await repos.runs.update(runId, { progress });
      // oxlint-disable-next-line no-await-in-loop
      await stage.run(ctx);
    }
    await repos.runs.update(runId, {
      status: partial.length ? 'partial' : 'succeeded',
      finishedAt: nowIso(),
      progress: {
        step: 'run.finish',
        done: total,
        total,
        changes: changes.length,
        ...(partial.length ? { partial } : {}),
      },
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
