import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serialise } from './cyclonedx.ts';
import { buildPythonComponents, buildPythonSbom, parsePyprojectDeps, parseUvLock } from './python.ts';

const read = (name: string): string => readFileSync(join(import.meta.dirname, 'test-fixtures', name), 'utf8');
const licences = { alpha: 'MIT', 'beta-pkg': 'BSD-3-Clause', gamma: 'ISC' };

describe('Python SBOM', () => {
  it('reads exact pins and rejects loose specifiers', () => {
    expect([...parsePyprojectDeps(read('pyproject.toml'))]).toEqual([
      ['alpha', '1.0.0'],
      ['beta-pkg', '2.0.0'],
    ]);
    expect(() => parsePyprojectDeps('[project]\ndependencies = ["alpha>=1"]\n')).toThrow(/pinned/);
  });

  it('never returns a partial list for extras or unsupported syntax', () => {
    const toml = '[project]\ndependencies = [\n  "uvicorn[standard]==0.54.0",\n  "fastapi==0.165.0", # api\n]\n';
    expect([...parsePyprojectDeps(toml)]).toEqual([
      ['uvicorn', '0.54.0'],
      ['fastapi', '0.165.0'],
    ]);
    expect(() => parsePyprojectDeps('[project]\ndependencies = [\n  "a==1", {x=1}\n]\n')).toThrow(/cannot parse/);
    expect(() => parsePyprojectDeps('[project]\ndependencies = [\n  "a==1"\n')).toThrow(/cannot parse/);
  });

  it.each([
    ['comment after the header', '[project] # application metadata\ndependencies = ["a==1"]\n'],
    ['indented key', '[project]\n  dependencies = [ "a==1" ]\n'],
    ['key comment and trailing space', '[project]\ndependencies = ["a==1"] # pins  \n'],
    ['single quotes', "[project]\ndependencies = ['a==1']\n"],
    [
      'multi-line with trailing comma and comments',
      '[project]\ndependencies = [\n  # runtime\n  "a==1", # first\n]\n[tool.uv]\n',
    ],
    [
      'indented header and following table',
      '  [project]  \nname = "x"\ndependencies=["a==1"]\n[tool.uv]\ndependencies = ["zzz"]\n',
    ],
  ])('reads valid TOML forms: %s', (_name, toml) => {
    expect([...parsePyprojectDeps(toml)]).toEqual([['a', '1']]);
  });

  it('fails clearly instead of returning an empty list', () => {
    expect(() => parsePyprojectDeps('[tool.uv]\nx = 1\n')).toThrow(/no \[project\] table/);
    expect(() => parsePyprojectDeps('[project]\ndependencies = "a==1"\n')).toThrow(/array of strings/);
    expect([...parsePyprojectDeps('[project]\nname = "x"\n')]).toEqual([]);
  });

  it('lists direct packages only without uv.lock and states the coverage', () => {
    const input = { pyproject: read('pyproject.toml'), licences };
    expect(buildPythonComponents(input).map((c) => c.name)).toEqual(['alpha', 'beta-pkg']);
    const bom = buildPythonSbom(input);
    expect(bom.metadata.properties.find((p) => p.name === 'olcys:coverage')?.value).toMatch(/direct dependencies only/);
  });

  it('adds transitive packages and hashes from uv.lock, skipping the project itself', () => {
    const input = { pyproject: read('pyproject.toml'), uvLock: read('uv.lock'), licences };
    expect(parseUvLock(input.uvLock).find((p) => p.name === 'fixture')?.virtual).toBe(true);
    const bom = buildPythonSbom(input);
    expect(bom.components.map((c) => c.purl)).toEqual([
      'pkg:pypi/alpha@1.0.0',
      'pkg:pypi/beta-pkg@2.0.0',
      'pkg:pypi/gamma@3.0.0',
    ]);
    expect(bom.components[0]?.hashes).toEqual([{ alg: 'SHA-256', content: 'aaaa' }]);
    expect(serialise(bom)).toBe(serialise(buildPythonSbom(input)));
  });

  it('leaves unknown packages without a licence (the gate then fails them)', () => {
    const [alpha] = buildPythonComponents({ pyproject: read('pyproject.toml'), licences: {} });
    expect(alpha?.licence).toBeNull();
  });
});
