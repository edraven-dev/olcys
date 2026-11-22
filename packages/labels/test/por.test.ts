import { describe, expect, it } from 'vitest';
import { loadPorProfiles, parsePorCsv } from '../src/index.ts';
import { ctxFor, fixture } from './importers-helpers.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const profiles = loadPorProfiles(
  readFileSync(fileURLToPath(new URL('../../../config/labels/por-profiles.v1.yaml', import.meta.url)), 'utf8'),
);

describe('proof-of-reserves CSV', () => {
  it('skips the totals block and unknown networks, versions by report date', () => {
    const { rows, warnings } = parsePorCsv(
      fixture('por-okx.synthetic.csv'),
      profiles['okx']!,
      ctxFor('por-file', '2026-11-01'),
    );
    expect(rows.map((r) => r.address.chain)).toEqual(['bitcoin', 'evm:1', 'tron']);
    expect(rows[0]).toMatchObject({ entity: 'OKX', category: 'exchange' });
    expect(rows[0]?.provenance).toMatchObject({
      version: '2026-11-01',
      sourceType: 'por_file',
      deciding: true,
      license: 'LicenseRef-Publisher-Disclosure',
    });
    expect(warnings.join()).toContain('Dogecoin');
  });
});
