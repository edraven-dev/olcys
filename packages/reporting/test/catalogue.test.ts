import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICD203_SCALE, pl } from '../src/index.ts';

const weights = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'config', 'scoring', 'weights.v1.yaml'),
  'utf8',
);

describe('Polish catalogue', () => {
  it('uses the ICD 203 scale and Polish terms of the weights file', () => {
    const rows = [...weights.matchAll(/- \{ max: ([\d.]+), term: ([^,]+), pl: '([^']+)' \}/g)].map((m) => ({
      max: Number(m[1]),
      term: m[2] ?? '',
      pl: m[3] ?? '',
    }));
    expect(rows).toHaveLength(7);
    expect(ICD203_SCALE.map((s) => ({ max: s.max, term: s.term }))).toEqual(
      rows.map(({ max, term }) => ({ max, term })),
    );
    for (const row of rows) expect(pl.icd203[row.term]).toBe(row.pl);
    expect(pl.icd203['not assessed']).toBe('nie oceniono');
  });

  it('has a Polish label for every scoring feature and ENFSI term', () => {
    const features = [...weights.matchAll(/^ {4}([a-z0-9_]+):/gm)].map((m) => m[1] ?? '');
    expect(features.length).toBeGreaterThan(10);
    expect(Object.keys(pl.features)).toEqual(expect.arrayContaining(features));
    const enfsi = [...weights.matchAll(/- \{ maxLr: [^,]+, term: ([^}]+?) \}/g)].map((m) => m[1] ?? '');
    expect(enfsi).toHaveLength(7);
    expect(Object.keys(pl.enfsi)).toEqual(expect.arrayContaining(enfsi));
  });
});
