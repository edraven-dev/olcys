import type { Repositories } from '@olcys/core';
import type { Db } from '../client.ts';
import { sqlAnalysisRepository, sqlChainDataRepository, sqlLabelRepository } from './analysis.ts';
import { sqlCaseRepository } from './cases.ts';
import { sqlEvidenceRepository } from './evidence.ts';
import { sqlRunRepository } from './runs.ts';

/** PostgreSQL (Kysely) implementations of every repository port. */
export function createSqlRepositories(db: Db): Repositories {
  return {
    cases: sqlCaseRepository(db),
    runs: sqlRunRepository(db),
    evidence: sqlEvidenceRepository(db),
    chain: sqlChainDataRepository(db),
    analysis: sqlAnalysisRepository(db),
    labels: sqlLabelRepository(db),
  };
}

export { sqlAnalysisRepository, sqlChainDataRepository, sqlLabelRepository } from './analysis.ts';
export { sqlCaseRepository } from './cases.ts';
export { sqlEvidenceRepository } from './evidence.ts';
export { sqlRunRepository } from './runs.ts';
