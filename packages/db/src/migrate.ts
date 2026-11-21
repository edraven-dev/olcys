/**
 * Ordered SQL migrations (`packages/db/migrations/NNNN_*.sql`), each applied in its own Kysely transaction as the
 * schema owner. Applied files are recorded with their SHA-256; editing an applied migration is refused.
 *
 *   node --env-file-if-exists=.env packages/db/src/migrate.ts          # apply
 *   node --env-file-if-exists=.env packages/db/src/migrate.ts --status # list
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Db } from './client.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export interface MigrationStatus {
  version: string;
  name: string;
  applied: boolean;
}

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  sha256: string;
}

function listFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .toSorted()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      return {
        version: file.slice(0, 4),
        name: file,
        sql: text,
        sha256: createHash('sha256').update(text).digest('hex'),
      };
    });
}

async function ensureTable(db: Db): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS olcys.schema_migrations (
    version text PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`.execute(
    db,
  );
  // Default privileges in schema olcys grant INSERT to the application role. Migration history is trusted by
  // migrate(), so only the owner may write it: revoke write privileges from every other grantee.
  await sql`DO $$
    DECLARE grantee text;
    BEGIN
      FOR grantee IN
        SELECT DISTINCT r.rolname
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        JOIN pg_roles r ON r.oid = a.grantee
        WHERE c.oid = 'olcys.schema_migrations'::regclass
          AND a.grantee <> c.relowner
          AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      LOOP
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON olcys.schema_migrations FROM %I', grantee);
      END LOOP;
    END $$`.execute(db);
}

async function appliedHashes(db: Db): Promise<Map<string, string>> {
  const rows = await db.selectFrom('schema_migrations').select(['version', 'sha256']).execute();
  return new Map(rows.map((r) => [r.version, r.sha256]));
}

export async function migrate(ownerUrl: string, dir: string = MIGRATIONS_DIR): Promise<{ applied: string[] }> {
  const db = createDb(ownerUrl, { max: 1 });
  try {
    // One migrator at a time (parallel test files, two deployments): the single pooled connection holds the session
    // lock until `destroy()` closes it, and the applied set is read only once the lock is held.
    await sql`SELECT pg_advisory_lock(hashtext('olcys:migrate'))`.execute(db);
    await ensureTable(db);
    const done = await appliedHashes(db);
    const applied: string[] = [];
    for (const file of listFiles(dir)) {
      const known = done.get(file.version);
      if (known !== undefined) {
        if (known !== file.sha256)
          throw new Error(`migration ${file.name} was edited after being applied (hash mismatch)`);
        continue;
      }
      // Sequential on purpose: migrations apply strictly in order.
      // oxlint-disable-next-line no-await-in-loop
      await db.transaction().execute(async (trx) => {
        await sql.raw(file.sql).execute(trx);
        await trx
          .insertInto('schema_migrations')
          .values({ version: file.version, name: file.name, sha256: file.sha256 })
          .execute();
      });
      applied.push(file.name);
    }
    return { applied };
  } finally {
    await db.destroy();
  }
}

export async function migrationStatus(ownerUrl: string, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  const db = createDb(ownerUrl, { max: 1 });
  try {
    await ensureTable(db);
    const done = await appliedHashes(db);
    return listFiles(dir).map((f) => ({ version: f.version, name: f.name, applied: done.has(f.version) }));
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  const url = process.env['DATABASE_URL_OWNER'];
  if (!url) {
    console.error('DATABASE_URL_OWNER is not set (see .env.example)');
    process.exit(1);
  }
  if (process.argv.includes('--status')) {
    for (const m of await migrationStatus(url)) console.info(`${m.applied ? '✔' : '·'} ${m.name}`);
  } else {
    const { applied } = await migrate(url);
    console.info(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  }
}
