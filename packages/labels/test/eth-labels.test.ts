import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkImportPolicy, importContext, readEthLabels } from '../src/index.ts';
import { registry } from './importers-helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'olcys-eth-labels-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dbPath = join(dir, 'labels.sqlite');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE accounts (chain_id INTEGER, address TEXT, label TEXT, name_tag TEXT)');
const insert = db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?)');
insert.run(1, '0x4444444444444444444444444444444444444444', 'kraken', 'Kraken 1 (SYNTHETIC)');
insert.run(8453, '0x5555555555555555555555555555555555555555', 'dex', null);
insert.run(1, '0x6666666666666666666666666666666666666666', 'mystery-slug', null);
db.close();

describe('eth-labels', () => {
  it('refuses without a justification and imports as corroborating only with one', () => {
    const refused = checkImportPolicy(registry, 'eth-labels');
    expect(refused).toMatchObject({ ok: false, reason: 'justification_required' });
    const allowed = checkImportPolicy(registry, 'eth-labels', { justification: 'case 7: corroborate exchange labels' });
    if (!allowed.ok) throw new Error('expected allowed');
    const ctx = importContext(allowed.entry, { version: 'sqlite-2026-11', retrievedAt: '2026-11-22T08:00:00.000Z' });
    const { rows, warnings } = readEthLabels(dbPath, ctx);
    expect(rows.map((r) => [r.address.chain, r.category])).toEqual([
      ['evm:1', 'exchange'],
      ['evm:8453', 'defi_dex'],
    ]);
    expect(rows[0]?.provenance).toMatchObject({ deciding: false, sourceType: 'etherscan_derived' });
    expect(warnings.join()).toContain('mystery-slug');
  });

  it('refuses a deciding context', () => {
    const allowed = checkImportPolicy(registry, 'eth-labels', { justification: 'x' });
    if (!allowed.ok) throw new Error('expected allowed');
    const ctx = {
      ...importContext(allowed.entry, { version: 'v', retrievedAt: '2026-11-22T08:00:00.000Z' }),
      deciding: true,
    };
    expect(() => readEthLabels(dbPath, ctx)).toThrow(/never decides/);
  });
});
