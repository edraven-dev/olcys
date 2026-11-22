import type { AddressTypeClassification, AddressTypeRepository, ChainId } from '@olcys/core';
import { sql, type Selectable } from 'kysely';
import { json, type Db } from '../client.ts';
import type { Database } from '../schema.ts';

type Row = Selectable<Database['address_type_classification']>;

/** A stored row as the classification it was written from (absent optional fields stay absent). */
function fromRow(r: Row): AddressTypeClassification {
  const c: AddressTypeClassification = {
    address: { chain: r.chain as ChainId, address: r.address },
    type: r.type,
    fetchIds: r.fetch_ids,
  };
  if (r.code_prefix !== null) c.codePrefix = r.code_prefix;
  if (r.code_size !== null) c.codeSize = r.code_size;
  if (r.delegate !== null) c.delegate = r.delegate;
  if (r.safe_master_copy !== null) c.safeMasterCopy = r.safe_master_copy;
  if (r.entry_point !== null) c.entryPoint = r.entry_point;
  if (r.implementation !== null) c.implementation = r.implementation;
  if (r.script_type) c.scriptType = r.script_type;
  if (r.failed_probe) c.failedProbe = r.failed_probe;
  return c;
}

/** PostgreSQL address-type classifications (append-only; unique per run, chain and address). */
export function sqlAddressTypeRepository(db: Db): AddressTypeRepository {
  return {
    async add(runId, classifications) {
      if (!classifications.length) return;
      await db
        .insertInto('address_type_classification')
        .values(
          classifications.map((c) => ({
            run_id: runId,
            chain: c.address.chain,
            address: c.address.address,
            type: c.type,
            code_prefix: c.codePrefix ?? null,
            code_size: c.codeSize ?? null,
            delegate: c.delegate ?? null,
            safe_master_copy: c.safeMasterCopy ?? null,
            entry_point: c.entryPoint ?? null,
            implementation: c.implementation ?? null,
            script_type: c.scriptType ?? null,
            failed_probe: c.failedProbe ? json(c.failedProbe) : null,
            // A uuid[] column: the driver sends the array as a PostgreSQL array, in order.
            fetch_ids: c.fetchIds,
          })),
        )
        .execute();
    },

    async list(runId) {
      const rows = await db
        .selectFrom('address_type_classification')
        .selectAll()
        .where('run_id', '=', runId)
        // Code-point order, as the in-memory store sorts (independent of the database collation).
        .orderBy(sql`chain collate "C"`)
        .orderBy(sql`address collate "C"`)
        .execute();
      return rows.map(fromRow);
    },
  };
}
