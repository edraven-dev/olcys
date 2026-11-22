/** Analyst overrides in runs: a rescore fixes the set it applies when it is queued; scoring reads exactly that set. */
import type { AnalystOverride, RunConfigSnapshot } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { runOverrides } from '../src/analyst.ts';
import { createRun } from '../src/index.ts';

const config: RunConfigSnapshot = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: 'a'.repeat(64),
  weightsVersion: 'weights.v2',
  weightsSha256: 'b'.repeat(64),
  rulesVersions: { exclusion: 'exclusion.v1' },
};

async function seed() {
  const repos = createMemoryRepositories();
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test korekt)',
      purpose: 'Test korekt analityka na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
    },
    'test',
  );
  const collected = await createRun(repos, { caseId: kase.id, mode: 'offline' }, config);
  await repos.runs.update(collected.id, { status: 'succeeded' });
  return { repos, caseId: kase.id, collected };
}

const override = (caseId: string, at: string): AnalystOverride => ({
  id: newId(),
  caseId,
  kind: 'reliability_grade',
  target: { sourceId: 'fixture_site' },
  value: 'B',
  justification: 'Ocena źródła na danych syntetycznych',
  analyst: 'Analityk Testowy',
  at,
});

describe('analyst overrides in runs', () => {
  it('a rescore fixes its override set when queued; a later override with an earlier time never slips in', async () => {
    const { repos, caseId, collected } = await seed();
    const first = override(caseId, '2026-11-21T09:00:00.000Z');
    await repos.overrides!.add(first);
    const rescore = await createRun(
      repos,
      { caseId, mode: 'offline', trigger: 'rescore', rescoreOfRunId: collected.id },
      config,
    );
    expect(rescore.config.analystOverrides).toEqual([first.id]);
    expect(rescore.config.rulesVersions).toEqual({ exclusion: 'exclusion.v1', overrides: `overrides@1:${first.id}` });
    // Stored after the run was queued, although its time precedes the queue time (e.g. a slow concurrent request).
    const late = override(caseId, new Date(Date.parse(rescore.queuedAt) - 60_000).toISOString());
    await repos.overrides!.add(late);
    expect((await runOverrides(repos, rescore)).map((o) => o.id)).toEqual([first.id]);
    // The runtime's shared snapshot is not modified.
    expect(config.rulesVersions).toEqual({ exclusion: 'exclusion.v1' });
    expect(config.analystOverrides).toBeUndefined();
  });

  it('collecting runs apply no overrides; a recorded override that is missing is an error', async () => {
    const { repos, caseId } = await seed();
    await repos.overrides!.add(override(caseId, '2026-11-21T09:00:00.000Z'));
    const manual = await createRun(repos, { caseId, mode: 'offline' }, config);
    expect(manual.config.analystOverrides).toBeUndefined();
    expect(manual.config.rulesVersions['overrides']).toBeUndefined();
    expect(await runOverrides(repos, manual)).toEqual([]);
    const forged = {
      ...manual,
      trigger: 'rescore' as const,
      config: { ...manual.config, analystOverrides: [newId()] },
    };
    await expect(runOverrides(repos, forged)).rejects.toThrow(/not found/);
  });
});
