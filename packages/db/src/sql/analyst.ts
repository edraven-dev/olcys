/**
 * Analyst judgements and overrides (append-only: the application role may only insert and read). Lists are ordered
 * oldest first by (`at`, `id`), so the latest entry is the last one.
 */
import type { AnalystJudgement, AnalystOverride, JudgementRepository, OverrideRepository } from '@olcys/core';
import type { Selectable } from 'kysely';
import { json, type Db } from '../client.ts';
import type { AnalystJudgementsTable, AnalystOverridesTable } from '../schema.ts';

function toJudgement(row: Selectable<AnalystJudgementsTable>): AnalystJudgement {
  return {
    id: row.id,
    linkAssessmentId: row.link_assessment_id,
    judgement: row.judgement,
    justification: row.justification,
    analyst: row.analyst,
    at: row.at.toISOString(),
  };
}

function toOverride(row: Selectable<AnalystOverridesTable>): AnalystOverride {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    target: row.target,
    value: row.value,
    justification: row.justification,
    analyst: row.analyst,
    at: row.at.toISOString(),
  };
}

export function sqlJudgementRepository(db: Db): JudgementRepository {
  return {
    async add(judgement) {
      await db
        .insertInto('analyst_judgements')
        .values({
          id: judgement.id,
          link_assessment_id: judgement.linkAssessmentId,
          judgement: judgement.judgement,
          justification: judgement.justification,
          analyst: judgement.analyst,
          at: judgement.at,
        })
        .execute();
    },

    async listByLink(linkAssessmentId) {
      const rows = await db
        .selectFrom('analyst_judgements')
        .selectAll()
        .where('link_assessment_id', '=', linkAssessmentId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map(toJudgement);
    },

    async listByRun(runId) {
      const rows = await db
        .selectFrom('analyst_judgements')
        .innerJoin('link_assessments', 'link_assessments.id', 'analyst_judgements.link_assessment_id')
        .selectAll('analyst_judgements')
        .where('link_assessments.run_id', '=', runId)
        .orderBy('analyst_judgements.at')
        .orderBy('analyst_judgements.id')
        .execute();
      return rows.map(toJudgement);
    },
  };
}

export function sqlOverrideRepository(db: Db): OverrideRepository {
  return {
    async add(override) {
      await db
        .insertInto('analyst_overrides')
        .values({
          id: override.id,
          case_id: override.caseId,
          kind: override.kind,
          target: json(override.target),
          value: override.value,
          justification: override.justification,
          analyst: override.analyst,
          at: override.at,
        })
        .execute();
    },

    async listByCase(caseId) {
      const rows = await db
        .selectFrom('analyst_overrides')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map(toOverride);
    },
  };
}
