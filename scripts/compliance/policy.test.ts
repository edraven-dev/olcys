import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyExceptions,
  decideComponent,
  loadExceptions,
  evaluateLicence,
  loadPolicy,
  type ComponentLicence,
  type LicencePolicy,
} from './policy.ts';

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

const exception = (licence: string) => ({
  package: 'pkg@1.0.0',
  licence,
  decision: 'allow' as const,
  reason: 'read the text',
  approvedBy: 'x',
  date: '2026-01-01',
});

const image = (name: string, version: string): ComponentLicence => ({
  ecosystem: 'image',
  name,
  version,
  licence: 'MIT',
  scope: 'runtime',
  direct: true,
});

describe('exceptions and unknown terms', () => {
  const base: ComponentLicence = {
    ecosystem: 'npm',
    name: 'pkg',
    version: '1.0.0',
    licence: 'NOASSERTION',
    scope: 'runtime',
    direct: true,
  };
  it('judges the reviewed licence of an exception by the same policy', () => {
    expect(decideComponent(base, policy, [exception('MIT')]).verdict).toBe('allow');
    expect(decideComponent(base, policy, [exception('BUSL-1.1')]).verdict).toBe('deny');
    expect(decideComponent(base, policy, [exception('GPL-3.0-only')]).verdict).toBe('deny');
    expect(decideComponent(base, policy, [exception('SEE LICENSE IN X')]).verdict).toBe('review');
    expect(
      decideComponent({ ...base, ecosystem: 'image', separateService: true }, policy, [exception('GPL-3.0-only')])
        .verdict,
    ).toBe('allow');
  });

  it('uses the reviewed licence for the SBOM data', () => {
    const [applied] = applyExceptions([base], policy, [exception('MIT')]);
    expect(applied?.licence).toBe('MIT');
    expect(applyExceptions([{ ...base, licence: 'ISC' }], policy, [exception('MIT')])[0]?.licence).toBe('ISC');
  });

  it('keeps a known restriction when an AND has an unknown term', () => {
    expect(evaluateLicence('GPL-3.0-only AND LicenseRef-Custom', policy).verdict).toBe('separate_service_only');
    expect(evaluateLicence('LicenseRef-Custom AND GPL-3.0-only', policy).verdict).toBe('separate_service_only');
    expect(evaluateLicence('BUSL-1.1 AND LicenseRef-Custom', policy).verdict).toBe('deny');
    expect(evaluateLicence('MIT AND LicenseRef-Custom', policy).verdict).toBe('review');
    const gplAnd = { ...base, licence: 'GPL-3.0-only AND LicenseRef-Custom' };
    expect(decideComponent(gplAnd, policy, [{ ...exception('MIT'), package: 'pkg@1.0.0' }]).verdict).toBe('deny');
  });

  it('matches forbidden images like the dependency scan (registry prefix, version limit)', () => {
    expect(decideComponent(image('redis', '7.4'), policy).verdict).toBe('allow');
    expect(decideComponent(image('redis', '8.0'), policy).verdict).toBe('deny');
    expect(decideComponent(image('docker.io/library/redis', '8'), policy).verdict).toBe('deny');
  });

  it('treats only a missing exceptions file as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exc-'));
    expect(await loadExceptions(root)).toEqual([]);
    await mkdir(join(root, 'config', 'compliance', 'license-exceptions.yaml'), { recursive: true });
    await expect(loadExceptions(root)).rejects.toThrow(/EISDIR|illegal operation/);
    await writeFile(join(root, 'x'), '');
  });
});
