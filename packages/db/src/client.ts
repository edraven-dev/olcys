import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;

/** Kysely instance bound to the `olcys` schema. Runtime code connects as `olcys_app` (append-only). */
export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema('olcys');
}

/** Serialises a value for a jsonb column (arrays included — never rely on the driver's array conversion). */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
