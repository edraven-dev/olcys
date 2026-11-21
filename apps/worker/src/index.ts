/** @olcys/worker as a library: the composition root and the analysis pipeline, used in-process by the API. */
export { loadConfig, REPO_ROOT, TOOL_VERSION, type LoadedConfig } from './config.ts';
export {
  createRun,
  diffWithPrevious,
  evidenceRunIdOf,
  runPipeline,
  type PipelineDeps,
  type Stage,
  type StageContext,
  type StartRunInput,
} from './pipeline.ts';
export { consoleLogger, createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts';
export {
  latestOccurrence,
  minIntervalFor,
  nextOccurrences,
  NEXT_RUNS_SHOWN,
  validateCron,
  type CronCheck,
} from './cron.ts';
export {
  createScheduler,
  decideTick,
  dueOccurrence,
  scheduleJobId,
  schedulesOf,
  schedulingSettings,
  type ScheduleReconcileReport,
  type Scheduler,
  type SchedulerOptions,
  type SchedulingSettings,
} from './scheduler.ts';
export {
  createChainStage,
  createCollectStage,
  createExtractStage,
  createScoreStage,
  defaultStages,
  USER_AGENT,
  type StageOptions,
} from './stages.ts';
