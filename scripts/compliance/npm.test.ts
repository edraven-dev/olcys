import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serialise } from './cyclonedx.ts';
import { buildNpmComponents, buildNpmSbom, makeResolver, type OptionalLicenceRule } from './npm.ts';

const lockfile = readFileSync(join(import.meta.dirname, 'test-fixtures', 'pnpm-lock.yaml'), 'utf8');
const installed = new Map<string, string | null>([
  ['@scope/lib@1.2.3', 'MIT'],
  ['dev-tool@3.0.0', 'ISC'],
  ['helper@0.1.0', '(MIT OR Apache-2.0)'],
  ['native-linux@1.0.0', 'MIT'],
  ['peer-dep@2.0.0', 'BSD-3-Clause'],
  ['peer-user@4.0.0', null],
]);
const rules: OptionalLicenceRule[] = [{ pattern: 'native-*', licence: 'MIT' }];
const resolver = makeResolver(installed, rules);

describe('npm SBOM', () => {
  it('lists exactly one component per lockfile package of the workspace document', () => {
    const bom = buildNpmSbom(lockfile, resolver);
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.6');
    expect(bom.components.map((c) => c.purl)).toEqual([
      'pkg:npm/%40scope/lib@1.2.3',
      'pkg:npm/dev-tool@3.0.0',
      'pkg:npm/helper@0.1.0',
      'pkg:npm/native-linux@1.0.0',
      'pkg:npm/native-win32@1.0.0',
      'pkg:npm/peer-dep@2.0.0',
      'pkg:npm/peer-user@4.0.0',
    ]);
    expect(bom.components.find((c) => c.name === 'lib')?.group).toBe('@scope');
  });

  it('is deterministic and carries no timestamp or serial number', () => {
    const a = serialise(buildNpmSbom(lockfile, resolver));
    const b = serialise(buildNpmSbom(lockfile, resolver));
    expect(a).toBe(b);
    expect(a).not.toMatch(/serialNumber|timestamp/);
    expect(a).toMatch(/olcys:lockfile-sha256/);
  });

  it('marks dev-only packages as excluded and shared ones as required', () => {
    const scopes = Object.fromEntries(buildNpmSbom(lockfile, resolver).components.map((c) => [c.name, c.scope]));
    expect(scopes['dev-tool']).toBe('excluded');
    expect(scopes['peer-user']).toBe('excluded');
    expect(scopes['peer-dep']).toBe('excluded');
    expect(scopes['lib']).toBe('required');
    expect(scopes['helper']).toBe('required'); // reachable from a production dependency too
    expect(scopes['native-win32']).toBe('required');
  });

  it('records licences, hashes and dependencies', () => {
    const bom = buildNpmSbom(lockfile, resolver);
    const lib = bom.components[0];
    expect(lib?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(lib?.hashes?.[0]?.alg).toBe('SHA-512');
    expect(bom.components.find((c) => c.name === 'helper')?.licenses).toEqual([{ expression: '(MIT OR Apache-2.0)' }]);
    expect(bom.components.find((c) => c.name === 'peer-user')?.licenses).toBeUndefined();
    expect(bom.dependencies.find((d) => d.ref === 'pkg:npm/%40scope/lib@1.2.3')?.dependsOn).toEqual([
      'pkg:npm/helper@0.1.0',
      'pkg:npm/native-linux@1.0.0',
      'pkg:npm/native-win32@1.0.0',
    ]);
    expect(bom.dependencies[0]?.ref).toBe('pkg:npm/olcys');
  });

  it('falls back to the committed rule for packages that are not installed', () => {
    const win = buildNpmComponents(lockfile, resolver).find((c) => c.name === 'native-win32');
    expect(win?.licence).toBe('MIT');
  });

  it('tracks direct dependencies per workspace and skips workspace links', () => {
    const components = buildNpmComponents(lockfile, resolver);
    const peerUser = components.find((c) => c.name === 'peer-user');
    expect(peerUser?.usedBy).toEqual([{ workspace: 'packages/app', dev: true }]);
    expect(components.find((c) => c.name === 'dev-tool')?.usedBy).toEqual([{ workspace: '.', dev: true }]);
    expect(components.find((c) => c.name === 'helper')?.direct).toBe(false);
    expect(components.some((c) => c.name === 'core' || c.name === 'pnpm-env-only')).toBe(false);
  });

  it('changes when a package is added to the lockfile (drift is detectable)', () => {
    const before = serialise(buildNpmSbom(lockfile, resolver));
    const extended = lockfile.replace(
      '  peer-dep@2.0.0:\n    resolution',
      '  extra@1.0.0:\n    resolution: {integrity: sha512-AAAA}\n\n  peer-dep@2.0.0:\n    resolution',
    );
    expect(extended).not.toBe(lockfile);
    expect(serialise(buildNpmSbom(extended, resolver))).not.toBe(before);
  });

  it('rejects a stale fallback rule that contradicts an installed sibling', () => {
    expect(() => makeResolver(new Map([['native-linux@1.0.0', 'GPL-3.0-only']]), rules)).toThrow(/native-\*/);
  });
});
