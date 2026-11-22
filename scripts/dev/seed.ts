/**
 * `pnpm seed`: creates the synthetic persona case once. Idempotent: a case with the persona's title (and created by
 * the seed analyst) means "already seeded" and nothing is written. Connects as the application role (DATABASE_URL).
 * The scope goes through the same `validateCaseScope` as `POST /api/cases`.
 */
import type { CaseRepository, CreateCaseInput } from '../../packages/core/src/index.ts';
import { loadSourceRegister, validateCaseScope, type SourceRegister } from '../../packages/collectors/src/index.ts';
import { createDb, createSqlRepositories } from '../../packages/db/src/index.ts';
import { personaCase } from './persona.ts';

export const SEED_ANALYST = 'seed';

export type SeedResult = { status: 'created'; caseId: string } | { status: 'already_seeded'; caseId: string };

export async function seedPersona(
  cases: CaseRepository,
  register: SourceRegister,
  input: CreateCaseInput = personaCase,
): Promise<SeedResult> {
  const violations = validateCaseScope(input.scope, register);
  if (violations.length > 0) throw new Error(`seed scope is invalid: ${JSON.stringify(violations)}`);
  const existing = (await cases.list()).find((c) => c.title === input.title && c.createdBy === SEED_ANALYST);
  if (existing) return { status: 'already_seeded', caseId: existing.id };
  const created = await cases.create(input, SEED_ANALYST);
  return { status: 'created', caseId: created.id };
}

if (import.meta.main) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }
  const db = createDb(url, { max: 1 });
  try {
    const result = await seedPersona(createSqlRepositories(db).cases, await loadSourceRegister());
    console.info(
      result.status === 'created'
        ? `seeded: created case ${result.caseId} (${personaCase.title})`
        : `already seeded: case ${result.caseId} exists, nothing created`,
    );
  } catch (error) {
    console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
