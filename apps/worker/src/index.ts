/** @olcys/worker as a library: the composition root and the analysis pipeline, used in-process by the API. */
export { loadConfig, REPO_ROOT, TOOL_VERSION, type LoadedConfig } from './config.ts';
export {
  createRun,
  diffWithPrevious,
  runPipeline,
  type PipelineDeps,
  type Stage,
  type StageContext,
  type StartRunInput,
} from './pipeline.ts';
export { consoleLogger, createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts';
export {
  createCollectStage,
  createExtractStage,
  createScoreStage,
  defaultStages,
  USER_AGENT,
  type StageOptions,
} from './stages.ts';
