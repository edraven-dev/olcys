import { describe, expect, it } from 'vitest';
import {
  createEnrichedLabelLookup,
  loadEntityMap,
  MemoryEntityLookup,
  MemoryLabelLookup,
  type EntityRecord,
} from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newId, type AddressLabel } from '@olcys/core';

const map = loadEntityMap(
  readFileSync(fileURLToPath(new URL('../../../config/labels/entity-map.v1.yaml', import.meta.url)), 'utf8'),
);
const record: EntityRecord = {
  registry: 'esma_casps',
  key: 'SYNTHBRAMKA000000T01',
  name: 'Bramka Testowa GmbH (SYNTHETIC)',
  fiatCapable: true,
  services: ['c'],
  validFrom: '2026-01-10',
};
const address = { chain: 'evm:1', address: '0x7777777777777777777777777777777777777777' } as const;
const label = (attributes: AddressLabel['attributes']): AddressLabel => ({
  id: newId(),
  address,
  entity: 'Bramka Testowa (SYNTHETIC)',
  category: 'payment_gateway',
  attributes,
  confidence: 90,
  provenance: {
    datasetId: 'demo',
    url: 'u',
    license: 'CC0-1.0',
    lastmod: '2026-11-01T00:00:00Z',
    retrievedAt: '2026-11-01T00:00:00Z',
  },
});

describe('entity enrichment', () => {
  const entities = new MemoryEntityLookup([record]);

  it('fills undefined attributes from records valid at the date', async () => {
    const lookup = createEnrichedLabelLookup(new MemoryLabelLookup([label({})]), entities, map);
    const [l] = await lookup.labelsFor(address, '2026-11-05T00:00:00Z');
    expect(l?.attributes).toMatchObject({ euAuthorised: true, fiatCapable: true });
    const [before] = await lookup.labelsFor(address, '2025-12-01T00:00:00Z');
    expect(before?.attributes.euAuthorised).toBeUndefined();
  });

  it('never overrides what the label already says', async () => {
    const lookup = createEnrichedLabelLookup(
      new MemoryLabelLookup([label({ fiatCapable: false, euAuthorised: false })]),
      entities,
      map,
    );
    const [l] = await lookup.labelsFor(address, '2026-11-05T00:00:00Z');
    expect(l?.attributes).toMatchObject({ fiatCapable: false, euAuthorised: false });
  });
});
