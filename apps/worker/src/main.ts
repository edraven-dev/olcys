/**
 * @olcys/worker — job runner and composition root. Skeleton only: the pipeline is not implemented yet.
 *
 * Pipeline (in-process stages run in order, idempotent per run):
 *   run.start → pivot.plan → collect.source* → extract.capture* → pivot.expand → chain.fetch*
 *   → labels.classify* → analytics.compute → score.links → llm.suggest → diff.previous → report.render → run.finish
 */
import { CORE_CONTRACTS_VERSION } from '@olcys/core';

const mode = process.env.OLCYS_MODE ?? 'offline';
console.info(
  `[worker] skeleton (contracts ${CORE_CONTRACTS_VERSION}, mode=${mode}) — job orchestration not implemented yet`,
);
