import { describe, expect, it } from 'vitest';
import { checkImportPolicy, loadDatasetRegistry } from '../src/index.ts';
import { registry } from './importers-helpers.ts';

describe('dataset registry policy', () => {
  it.each(['opensanctions', 'dune-spellbook', 'arkham', 'binance-vision'])('refuses %s', (id) => {
    expect(checkImportPolicy(registry, id)).toMatchObject({ ok: false, reason: 'dataset_licence_refused' });
    expect(checkImportPolicy(registry, id, { justification: 'please' })).toMatchObject({
      ok: false,
      reason: 'dataset_licence_refused',
    });
  });

  it('allows the open datasets and records their licence', () => {
    for (const id of ['graphsense-tagpacks', 'ofac-0xb10c', 'por-file', 'esma-casps', 'pl-vasp-register']) {
      expect(checkImportPolicy(registry, id)).toMatchObject({ ok: true, entry: { datasetId: id } });
    }
    expect(checkImportPolicy(registry, 'nope')).toMatchObject({ ok: false, reason: 'unknown_dataset' });
  });

  it('refuses a deciding dataset whose licence class may not decide', () => {
    const yaml = `datasets:\n  - {datasetId: x, kind: labels, sourceType: curated, url: u, license: L, licenseClass: unknown, deciding: true, enabledByDefault: true}\n`;
    expect(checkImportPolicy(loadDatasetRegistry(yaml), 'x')).toMatchObject({
      ok: false,
      reason: 'dataset_licence_refused',
    });
  });
});
