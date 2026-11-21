import type { Case, CaseRepository, CaseWithIdentifiers, Identifier } from '@olcys/core';
import { json, type Db } from '../client.ts';

interface CaseRow {
  id: string;
  title: string;
  purpose: string;
  legal_basis: string;
  status: 'open' | 'closed';
  scope: Case['scope'];
  created_at: Date;
  created_by: string;
}

interface IdentifierRow {
  id: string;
  case_id: string;
  kind: string;
  value: string;
  platform: string | null;
  chain: string | null;
  is_anchor: boolean;
  added_at: Date;
  added_by: string;
}

function toCase(row: CaseRow): Case {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose,
    legalBasis: row.legal_basis,
    status: row.status,
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  };
}

function toIdentifier(row: IdentifierRow): Identifier {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind as Identifier['kind'],
    value: row.value,
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.chain ? { chain: row.chain as NonNullable<Identifier['chain']> } : {}),
    isAnchor: row.is_anchor,
    addedAt: row.added_at.toISOString(),
    addedBy: row.added_by,
  };
}

export function sqlCaseRepository(db: Db): CaseRepository {
  return {
    async create(input, createdBy): Promise<CaseWithIdentifiers> {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('cases')
          .values({
            title: input.title,
            purpose: input.purpose,
            legal_basis: input.legalBasis,
            scope: json(input.scope),
            created_by: createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const identifiers = await trx
          .insertInto('case_identifiers')
          .values(
            input.identifiers.map((i) => ({
              case_id: row.id,
              kind: i.kind,
              value: i.value,
              platform: i.platform ?? null,
              chain: i.chain ?? null,
              is_anchor: i.isAnchor,
              added_by: createdBy,
            })),
          )
          .returningAll()
          .execute();
        return { ...toCase(row), identifiers: identifiers.map(toIdentifier) };
      });
    },

    async get(id) {
      const row = await db.selectFrom('cases').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) return undefined;
      const identifiers = await db
        .selectFrom('case_identifiers')
        .selectAll()
        .where('case_id', '=', id)
        .orderBy('added_at')
        .execute();
      return { ...toCase(row), identifiers: identifiers.map(toIdentifier) };
    },

    async list() {
      return (await db.selectFrom('cases').selectAll().orderBy('created_at', 'desc').execute()).map(toCase);
    },
  };
}
