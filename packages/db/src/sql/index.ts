import type { Repositories } from '@olcys/core';
import type { Db } from '../client.ts';
import { sqlAddressTypeRepository } from './address-types.ts';
import { sqlAnalysisRepository, sqlChainDataRepository, sqlLabelRepository } from './analysis.ts';
import { sqlJudgementRepository, sqlOverrideRepository } from './analyst.ts';
import { sqlCaseRepository } from './cases.ts';
import { sqlClusterRepository } from './clusters.ts';
import { sqlCustodyRepository } from './custody.ts';
import { sqlEvidenceRepository } from './evidence.ts';
import { sqlRunRepository } from './runs.ts';
import { sqlScheduleRepository } from './schedules.ts';
import { sqlTimestampRepository } from './timestamps.ts';

/** PostgreSQL (Kysely) implementations of every repository port. */
export function createSqlRepositories(db: Db): Repositories {
  return {
    cases: sqlCaseRepository(db),
    runs: sqlRunRepository(db),
    evidence: sqlEvidenceRepository(db),
    chain: sqlChainDataRepository(db),
    addressTypes: sqlAddressTypeRepository(db),
    clusters: sqlClusterRepository(db),
    analysis: sqlAnalysisRepository(db),
    labels: sqlLabelRepository(db),
    schedules: sqlScheduleRepository(db),
    judgements: sqlJudgementRepository(db),
    overrides: sqlOverrideRepository(db),
    custody: sqlCustodyRepository(db),
    timestamps: sqlTimestampRepository(db),
  };
}

export { sqlAddressTypeRepository } from './address-types.ts';
export { sqlAnalysisRepository, sqlChainDataRepository, sqlLabelRepository } from './analysis.ts';
export { sqlJudgementRepository, sqlOverrideRepository } from './analyst.ts';
export { sqlCaseRepository } from './cases.ts';
export { sqlClusterRepository } from './clusters.ts';
export { sqlCustodyRepository } from './custody.ts';
export { sqlEvidenceRepository } from './evidence.ts';
export { sqlRunRepository } from './runs.ts';
export { sqlScheduleRepository } from './schedules.ts';
export { attachTimestamps, sqlTimestampRepository } from './timestamps.ts';
