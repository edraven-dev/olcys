import type { AccessLogEntry, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

const entry = (at: string, caseId: string, extra: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
  id: newId(),
  at,
  actor: 'analityk.testowy',
  action: 'case.view',
  caseId,
  outcome: 'ok',
  ip: '127.0.0.1',
  ...extra,
});

async function roundTrip(repos: Repositories): Promise<void> {
  const log = repos.accessLog!;
  const caseId = newId();
  const first = entry('2026-11-21T10:00:00.000Z', caseId, { action: 'report.view', purpose: 'kontrola podatkowa' });
  const second = entry('2026-11-21T11:00:00.000Z', caseId, { actor: 'inny.analityk', resource: '/api/cases/:caseId' });
  await log.add(first);
  await log.add(second);
  await log.add(entry('2026-11-21T12:00:00.000Z', newId()));
  expect(await log.list({ caseId })).toEqual([second, first]);
  expect(await log.list({ caseId, actor: 'inny.analityk' })).toEqual([second]);
  expect(await log.list({ caseId, limit: 1 })).toEqual([second]);
}

describe('access log (memory)', () => {
  it('lists newest first and filters by case and actor', async () => {
    await expect(roundTrip(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)('access log (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;
  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('lists newest first and filters by case and actor', async () => {
    await expect(roundTrip(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated, deleted or truncated by the application role', async () => {
    const repos = createSqlRepositories(db);
    const caseId = newId();
    await repos.accessLog!.add(entry('2026-11-21T10:00:00.000Z', caseId));
    const denied = /permission denied/;
    await expect(
      db.updateTable('access_log').set({ actor: 'x' }).where('case_id', '=', caseId).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('access_log').where('case_id', '=', caseId).execute()).rejects.toThrow(denied);
    expect(await repos.accessLog!.list({ caseId })).toHaveLength(1);
  });
});
