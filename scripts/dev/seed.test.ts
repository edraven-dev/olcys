import { loadSourceRegister } from '../../packages/collectors/src/index.ts';
import { createMemoryRepositories } from '../../packages/db/src/index.ts';
import { describe, expect, it } from 'vitest';
import { personaCase } from './persona.ts';
import { seedPersona } from './seed.ts';

describe('seed', () => {
  it('creates the persona case once and reports "already_seeded" afterwards', async () => {
    const repos = createMemoryRepositories();
    const register = await loadSourceRegister();
    const first = await seedPersona(repos.cases, register);
    const second = await seedPersona(repos.cases, register);
    expect(first.status).toBe('created');
    expect(second).toEqual({ status: 'already_seeded', caseId: first.caseId });
    expect(await repos.cases.list()).toHaveLength(1);
    const stored = await repos.cases.get(first.caseId);
    expect(stored?.identifiers.map((i) => [i.kind, i.value, i.isAnchor])).toEqual([
      ['nickname', 'fikcyjny_kacper', true],
      ['full_name', 'Kacper Fikcyjny', false],
      ['email', 'kacper.fikcyjny@example.org', false],
    ]);
  });

  it('enables the chain providers, NBP and the registries with long enough AMBER justifications', () => {
    const { enabledSources, amberJustifications } = personaCase.scope;
    expect(enabledSources).toEqual(
      expect.arrayContaining(['mempool_space', 'etherscan_v2', 'trongrid', 'nbp_api', 'ceidg', 'vat_whitelist', 'krs']),
    );
    for (const text of Object.values(amberJustifications)) expect(text.length).toBeGreaterThanOrEqual(20);
  });

  it('refuses a scope the register rejects', async () => {
    const register = await loadSourceRegister();
    await expect(
      seedPersona(createMemoryRepositories().cases, register, {
        ...personaCase,
        scope: { ...personaCase.scope, amberJustifications: {} },
      }),
    ).rejects.toThrow(/scope is invalid/);
  });
});
