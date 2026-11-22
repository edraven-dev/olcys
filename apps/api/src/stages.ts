/**
 * Pipeline stages for the API process (which runs analyses in-process in the MVP): the worker's stages, configured
 * with the run mode, the source register and the process environment.
 */
import type { RunWithProgress } from '@olcys/core';
import type { Runtime, Stage } from '@olcys/worker';
import { defaultStages as workerStages, evidenceRunIdOf } from '@olcys/worker';

export function defaultStages(runtime: Pick<Runtime, 'sources' | 'mode'> & Partial<Pick<Runtime, 'llm'>>): Stage[] {
  return workerStages({
    mode: runtime.mode,
    sources: runtime.sources,
    env: process.env,
    ...(runtime.llm ? { llm: runtime.llm } : {}),
  });
}

/**
 * Renders a new version of a finished run's report with the pipeline's own report stage, e.g. so that it shows the
 * analyst judgements recorded after the run. Earlier versions stay stored.
 */
export function reportRenderer(
  runtime: Pick<Runtime, 'repos' | 'blobs' | 'logger' | 'sources' | 'mode'>,
): (run: RunWithProgress) => Promise<void> {
  const stage = defaultStages(runtime).find((s) => s.step === 'report.render');
  return async (run) => {
    if (!stage) throw new Error('the pipeline has no report stage');
    const kase = await runtime.repos.cases.get(run.caseId);
    if (!kase) throw new Error(`case ${run.caseId} not found`);
    await stage.run({
      run,
      evidenceRunId: evidenceRunIdOf(run),
      case: kase,
      repos: runtime.repos,
      blobs: runtime.blobs,
      logger: runtime.logger,
      async progress() {},
      markPartial() {},
    });
  };
}
