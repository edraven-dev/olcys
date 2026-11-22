import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
import { parseInteger, run } from '../scripts/calibrate.ts';
import { v2 } from './fixtures/helpers.ts';

const exec = promisify(execFile);
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

  it('the CLI writes the proposal only under --out and leaves the committed weights untouched', async () => {
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
      // The corpus is part of the repository, so relation accuracy is reported.
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

describe('argument validation', () => {
  it('accepts plain non-negative integers within range only', () => {
    expect(parseInteger('n', '20000', 1, 1_000_000)).toBe(20000);
    for (const bad of ['20_000', 'Infinity', 'NaN', '-5', '1.5', '', '0x10', '1e3', '1000001']) {
      expect(() => parseInteger('n', bad, 1, 1_000_000)).toThrow(/--n must be an integer/);
    }
    expect(() => parseInteger('seed', '4294967296', 0, 4_294_967_295)).toThrow(/--seed/);
  });

  it('run() rejects invalid numbers before writing anything', async () => {
    const out = await mkdtemp(join(tmpdir(), 'olcys-calibration-'));
    try {
      const bads = [
        { n: Number.NaN },
        { n: Number.POSITIVE_INFINITY },
        { n: 0 },
        { seed: -1 },
        { seed: 1.5 },
        { corpusLimit: 0 },
      ];
      await Promise.all(
        bads.map((bad) => expect(run({ oracle: true, out, ...bad })).rejects.toThrow(/must be an integer/)),
      );
      expect(await readdir(out)).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('the CLI exits 1 with a clear message and writes nothing for --n 20_000', async () => {
    const out = await mkdtemp(join(tmpdir(), 'olcys-calibration-'));
    try {
      const script = join(import.meta.dirname, '..', 'scripts', 'calibrate.ts');
      const failure = await exec(process.execPath, [script, '--oracle', '--n', '20_000', '--out', out]).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain('--n must be an integer');
      expect(await readdir(out)).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('proposal grades and corpus provenance', () => {
  it('leaves a feature unchanged when the data carry a grade other than its default, and says so', () => {
    const claims = generateClaims(
      [
        {
          id: 'regraded',
          label: 0.5,
          weight: 1,
          relation: 'SELF_DECLARED',
          anchor: true,
          identity: [],
          address: [{ feature: 'e3_ownership_cue', p: 0.5, grade: 'A' }],
        },
      ],
      400,
      5,
    );
    const report = calibrate(claims, w, { seed: 5, bootstrap: 0 });
    expect(report.features['e3_ownership_cue']?.grades).toEqual(['A']);
    const text = proposeWeights(report, w, 5);
    expect(text).toContain('Bez zmian (dane zawierają inny stopień wiarygodności niż domyślny): e3_ownership_cue');
    expect(parseWeights(new TextEncoder().encode(text)).features.get('e3_ownership_cue')?.bayesFactor).toBe(8);
  });

  it('records the extractor version, corpus hashes, deny-list hash and the cap with the corpus results', async () => {
    const out = await mkdtemp(join(tmpdir(), 'olcys-calibration-'));
    try {
      const { dir } = await run({ oracle: true, n: 300, seed: 6, out, corpusLimit: 8 });
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        corpus: Record<string, unknown>;
      };
      expect(report.corpus['extractorVersion']).toMatch(/^0\./);
      for (const key of ['manifestSha256', 'usedFilesSha256', 'denyListSha256']) {
        expect(report.corpus[key]).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(report.corpus['limit']).toBe(8);
      expect(report.corpus['documents']).toBe(8);
      const again = await run({ oracle: true, n: 300, seed: 6, out, corpusLimit: 8 });
      expect(await readFile(join(again.dir, 'report.json'), 'utf8')).toContain(
        String(report.corpus['usedFilesSha256']),
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
