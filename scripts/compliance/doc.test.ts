import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLicensesDoc,
  END_MARKER,
  renderLicensesDoc,
  replaceGenerated,
  START_MARKER,
  writeLicensesDoc,
  type LicensesDocInput,
} from './doc.ts';
import type { NpmComponent } from './npm.ts';

const npm = (name: string, direct: boolean, extra: Partial<NpmComponent> = {}): NpmComponent => ({
  ecosystem: 'npm',
  name,
  version: '1.0.0',
  licence: 'MIT',
  scope: 'runtime',
  direct,
  dependsOn: [],
  usedBy: direct ? [{ workspace: 'packages/core', dev: false }] : [],
  ...extra,
});

const input: LicensesDocInput = {
  npm: [npm('zod', true), npm('left-pad', false), npm('tslib', false, { licence: '0BSD', scope: 'dev' })],
  python: [],
  npmPurposes: { zod: 'walidacja | danych' },
  pythonPurposes: {},
  images: [],
  policy: { allowed: ['MIT', '0BSD'], separateServiceOnly: [], deny: [] },
  exceptions: [],
  sbomLinks: { npm: 'sbom/a.json', python: 'sbom/b.json' },
  pythonHasLock: false,
};

const shell = `# T\n\nprose\n\n${START_MARKER}\nold\n${END_MARKER}\n\n## Ręczna sekcja\n\n| a | b |\n`;

describe('licenses document', () => {
  it('renders the direct dependency table, the transitive summary and the SBOM links', () => {
    const out = renderLicensesDoc(input);
    expect(out).toContain('| zod | 1.0.0 | MIT | walidacja \\| danych | packages/core |');
    expect(out).not.toMatch(/\| left-pad \| 1\.0\.0 \| MIT \|\s*\|/);
    expect(out).toContain('| 0BSD | 0 | 1 | 1 |');
    expect(out).toContain('(sbom/a.json)');
    expect(out).toContain('wszystkie komponenty zgodne');
  });

  it('fails when a direct dependency has no Polish purpose', () => {
    expect(() => renderLicensesDoc({ ...input, npm: [...input.npm, npm('mystery', true)] })).toThrow(/mystery/);
  });

  it('replaces only the generated block and keeps the hand-maintained sections', () => {
    const next = replaceGenerated(shell, 'NEW');
    expect(next).toContain(`${START_MARKER}\n\nNEW\n\n${END_MARKER}`);
    expect(next.endsWith('## Ręczna sekcja\n\n| a | b |\n')).toBe(true);
    expect(replaceGenerated(next, 'NEW')).toBe(next);
    expect(() => replaceGenerated('no markers', 'x')).toThrow(/generated:licenses/);
  });

  it('--check detects drift and --write repairs it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'licdoc-'));
    const file = join(dir, 'licenses.md');
    await writeFile(file, shell);
    const generated = renderLicensesDoc(input);
    expect(await checkLicensesDoc(file, generated)).toBe(false);
    expect(await writeLicensesDoc(file, generated)).toBe(true);
    expect(await checkLicensesDoc(file, generated)).toBe(true);
    expect(await writeLicensesDoc(file, generated)).toBe(false);
    await writeFile(file, (await readFile(file, 'utf8')).replace('| zod |', '| zod2 |'));
    expect(await checkLicensesDoc(file, generated)).toBe(false);
  });
});
