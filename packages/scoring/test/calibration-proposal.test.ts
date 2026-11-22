import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  calibrate,
  generateClaims,
  oracleScenarios,
  parseWeights,
  proposeWeights,
  weightsPath,
  type ScoringWeights,
} from '../src/index.ts';
import { run } from '../scripts/calibrate.ts';
import { v2 } from './fixtures/helpers.ts';

let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const sha = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

describe('weights proposal and CLI', () => {
  it('proposes a file that parses, is labelled as a synthetic proposal and changes only well-measured features', () => {
    const report = calibrate(
      generateClaims(oracleScenarios(w), 20000, 20261121, (f) => w.features.get(f)?.tier),
      w,
      {
        seed: 20261121,
        bootstrap: 0,
      },
    );
    const text = proposeWeights(report, w);
    expect(text).toContain('propozycja z danych syntetycznych — wymaga przeglądu');
    expect(text).toContain(report.datasetSha256);
    const proposed = parseWeights(new TextEncoder().encode(text));
    expect(proposed.version).toBe('weights.v2-proposed');
    expect(proposed.status).toBe('uncalibrated');
    expect(proposed.features.size).toBe(w.features.size);
    // Sparse (< 30 in a class) and unmeasured features keep their value; measured ones are within clip and 3 digits.
    expect(proposed.features.get('e1_cryptographic_binding')?.bayesFactor).toBe(1000);
    for (const f of proposed.features.values()) {
      expect(f.bayesFactor).toBeGreaterThanOrEqual(1 / 1024);
      expect(f.bayesFactor).toBeLessThanOrEqual(1024);
    }
    const bare = proposed.features.get('e3_bare_mention')?.bayesFactor ?? 0;
    expect(Math.abs(bare - 2) / 2).toBeLessThan(0.4);
    expect(proposed.reliability).toEqual(w.reliability);
    expect(proposed.scales).toEqual(w.scales);
  });

  it('AC7 + smoke: the CLI writes the proposal only under --out and leaves the committed weights untouched', async () => {
    const before = await sha(weightsPath('weights.v1.yaml'));
    const beforeV2 = await sha(weightsPath('weights.v2.yaml'));
    const out = await mkdtemp(join(tmpdir(), 'olcys-calibration-'));
    try {
      const { dir, personaFailures } = await run({
        oracle: true,
        n: 1500,
        seed: 3,
        propose: true,
        out,
        corpusLimit: 12,
      });
      expect(personaFailures).toEqual([]);
      expect(dir.startsWith(out)).toBe(true);
      expect((await readdir(dir)).toSorted()).toEqual([
        'reliability.svg',
        'report.json',
        'report.md',
        'weights.v2-proposed.yaml',
      ]);
      parseWeights(new Uint8Array(await readFile(join(dir, 'weights.v2-proposed.yaml'))));
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        relationAccuracy?: { macroF1: number; confusion: object };
        weightsSha256: string;
      };
      // AC8: the corpus is part of the repository, so relation accuracy is reported.
      expect(report.relationAccuracy?.macroF1).toBeGreaterThan(0);
      expect(report.relationAccuracy?.confusion).toBeDefined();
      expect(report.weightsSha256).toBe(w.sha256);
      // A missing corpus: the field is absent and the warning is emitted.
      const none = await run({ oracle: true, n: 300, seed: 4, out, corpus: join(out, 'missing') });
      const bare = JSON.parse(await readFile(join(none.dir, 'report.json'), 'utf8')) as {
        relationAccuracy?: unknown;
        warnings: string[];
      };
      expect(bare.relationAccuracy).toBeUndefined();
      expect(bare.warnings).toContain('corpus_missing');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
    expect(await sha(weightsPath('weights.v1.yaml'))).toBe(before);
    expect(await sha(weightsPath('weights.v2.yaml'))).toBe(beforeV2);
  });
});
