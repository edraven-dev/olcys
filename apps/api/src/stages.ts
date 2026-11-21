/**
 * Pipeline stages wired for the API process. Each stage adapts one package (collectors, address extraction, chain
 * analytics, scoring, reporting) to the pipeline; they are registered here as the packages land.
 */
import type { Runtime, Stage } from '@olcys/worker';

export function defaultStages(
  _runtime: Pick<Runtime, 'repos' | 'blobs' | 'sources' | 'config' | 'mode' | 'logger'>,
): Stage[] {
  return [];
}
