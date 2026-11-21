/**
 * Pipeline stages for the API process (which runs analyses in-process in the MVP): the worker's stages, configured
 * with the run mode, the source register and the process environment.
 */
import type { Runtime, Stage } from '@olcys/worker';
import { defaultStages as workerStages } from '@olcys/worker';

export function defaultStages(runtime: Pick<Runtime, 'sources' | 'mode'>): Stage[] {
  return workerStages({ mode: runtime.mode, sources: runtime.sources, env: process.env });
}
