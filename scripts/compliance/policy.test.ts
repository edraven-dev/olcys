import { describe, expect, it } from 'vitest';
import { decideComponent, evaluateLicence, loadPolicy, type ComponentLicence, type LicencePolicy } from './policy.ts';

const policy: LicencePolicy = {
  allowed: ['MIT', 'ISC', 'BSD-3-Clause', 'BSL-1.0', 'Apache-2.0'],
  separateServiceOnly: ['GPL-*', 'AGPL-*', 'LGPL-*'],
  deny: ['BUSL-1.1', 'SSPL-1.0', 'CC-BY-NC*', 'LicenseRef-RSAL*', 'UNLICENSED'],
  forbidden: { npm: ['turbo', '@neo4j-nvl/*'], pypi: ['h8mail'], images: ['redis>=8'] },
};

describe('evaluateLicence', () => {
  it.each([
    ['BUSL-1.1', 'deny'],
    ['MIT OR GPL-3.0-only', 'allow'],
    ['(MIT OR GPL-3.0-only)', 'allow'],
    ['MIT AND CC-BY-NC-4.0', 'deny'],
    ['BSL-1.0', 'allow'],
    ['GPL-3.0-only', 'separate_service_only'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'separate_service_only'],
    ['MIT AND (ISC OR SSPL-1.0)', 'allow'],
    ['LicenseRef-RSAL-1.0', 'deny'],
    ['UNLICENSED', 'deny'],
    ['SEE LICENSE IN LICENSE.txt', 'review'],
    ['NOASSERTION', 'review'],
    ['Some Custom Thing', 'review'],
    ['Apache-2.0+', 'allow'],
    [null, 'review'],
    ['', 'review'],
  ])('%s -> %s', (expr, verdict) => {
    expect(evaluateLicence(expr, policy).verdict).toBe(verdict);
  });

  it('is case-insensitive and names the matching rule', () => {
    expect(evaluateLicence('mit', policy)).toEqual({ verdict: 'allow', rule: 'allowed:MIT' });
    expect(evaluateLicence('cc-by-nc-sa-4.0', policy).rule).toBe('deny:CC-BY-NC*');
  });
});

describe('decideComponent', () => {
  const base: ComponentLicence = {
    ecosystem: 'pypi',
    name: 'pkg',
    version: '1.0.0',
    licence: 'MIT',
    scope: 'runtime',
    direct: true,
  };

  it('denies copyleft inside npm and Python trees', () => {
    expect(decideComponent({ ...base, licence: 'GPL-3.0-only' }, policy).verdict).toBe('deny');
    expect(decideComponent({ ...base, ecosystem: 'npm', licence: 'AGPL-3.0-or-later' }, policy).verdict).toBe('deny');
  });

  it('allows copyleft images only as flagged separate services', () => {
    const image = { ...base, ecosystem: 'image' as const, licence: 'AGPL-3.0-only' };
    expect(decideComponent(image, policy).verdict).toBe('deny');
    expect(decideComponent({ ...image, separateService: true }, policy).verdict).toBe('allow');
  });

  it('sends missing and unresolved licences to review unless an exception exists', () => {
    expect(decideComponent({ ...base, licence: null }, policy).verdict).toBe('review');
    expect(decideComponent({ ...base, licence: 'SEE LICENSE IN LICENSE.txt' }, policy).verdict).toBe('review');
    const exception = {
      package: 'pkg@1.0.0',
      licence: 'MIT',
      decision: 'allow' as const,
      reason: 'read the text',
      approvedBy: 'x',
      date: '2026-01-01',
    };
    expect(decideComponent({ ...base, licence: null }, policy, [exception]).verdict).toBe('allow');
    expect(decideComponent({ ...base, licence: 'BUSL-1.1' }, policy, [exception]).verdict).toBe('deny');
  });

  it('denies packages of forbidden tools regardless of licence', () => {
    expect(decideComponent({ ...base, name: 'H8Mail' }, policy)).toEqual({ verdict: 'deny', rule: 'forbidden-tool' });
    expect(decideComponent({ ...base, ecosystem: 'npm', name: 'turbo' }, policy).verdict).toBe('deny');
    expect(decideComponent({ ...base, ecosystem: 'npm', name: '@neo4j-nvl/base' }, policy).verdict).toBe('deny');
    expect(decideComponent({ ...base, ecosystem: 'npm', name: 'turbo-not' }, policy).verdict).toBe('allow');
  });
});

describe('repository policy', () => {
  it('keeps the contract lists and loads the forbidden tools', async () => {
    const real = await loadPolicy();
    expect(real.allowed).toContain('MIT');
    expect(real.deny).toEqual(expect.arrayContaining(['BUSL-1.1', 'SSPL-1.0', 'UNLICENSED']));
    expect(real.separateServiceOnly).toEqual(expect.arrayContaining(['GPL-*', 'AGPL-*', 'LGPL-*']));
    expect(real.forbidden?.pypi).toContain('h8mail');
    expect(evaluateLicence('PSF-2.0', real).verdict).toBe('allow');
  });
});
