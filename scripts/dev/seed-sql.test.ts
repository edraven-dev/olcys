/** Gated: runs only against the throw-away test database (OLCYS_TEST_DATABASE_URL[_OWNER]); never the dev database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSourceRegister } from '../../packages/collectors/src/index.ts';
import { createDb, createSqlRepositories, migrate, type Db } from '../../packages/db/src/index.ts';
import { seedPersona } from './seed.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];

describe.skipIf(!appUrl || !ownerUrl)('seed against PostgreSQL', () => {
  let db: Db;
  beforeAll(async () => {
    await migrate(ownerUrl ?? '');
    db = createDb(appUrl ?? '', { max: 1 });
  });
  afterAll(async () => db?.destroy());

  it('is idempotent as the application role', async () => {
    const cases = createSqlRepositories(db).cases;
    const register = await loadSourceRegister();
    const first = await seedPersona(cases, register);
    const second = await seedPersona(cases, register);
    expect(second.status).toBe('already_seeded');
    expect(second.caseId).toBe(first.caseId);
    expect((await cases.list()).filter((c) => c.title.startsWith('Kacper Fikcyjny (demonstracja)'))).toHaveLength(1);
  });
});
