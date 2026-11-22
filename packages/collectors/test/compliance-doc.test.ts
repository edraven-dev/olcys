import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  checkSourcesDoc,
  DEFAULT_DOC_PATH,
  DEFAULT_FORBIDDEN_TOOLS_PATH,
  DEFAULT_SOURCES_PATH,
  DOC_END,
  DOC_START,
  loadForbiddenTools,
  loadSourceRegister,
  renderSourcesDoc,
  replaceGeneratedBlock,
  writeSourcesDoc,
} from '../src/index.ts';
import { REPO } from './helpers.ts';

const SCRIPT = join(REPO, 'packages', 'collectors', 'scripts', 'sources-doc.ts');

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'olcys-doc-'));
}

describe('generated compliance document', () => {
  it('the committed Polish document is current', async () => {
    expect((await checkSourcesDoc()).upToDate).toBe(true);
    const doc = await readFile(DEFAULT_DOC_PATH, 'utf8');
    expect(doc).not.toMatch(/OLC-\d+/);
  });

  it('renders the tables per status and the forbidden tools (Polish)', async () => {
    const block = renderSourcesDoc(await loadSourceRegister(), await loadForbiddenTools(), 'pl');
    for (const heading of ['### Źródła GREEN', '### Źródła AMBER', '### Źródła RED', '### Narzędzia niedozwolone']) {
      expect(block).toContain(heading);
    }
    expect(block).toContain(
      '| Źródło | Rodzaj | Domyślnie włączone | Limit zapytań | Ujawnia identyfikator | Wiarygodność (Admiralty) | Regulamin | Uzasadnienie |',
    );
    expect(block).toContain('brak opublikowanego regulaminu');
    expect(block).toContain('Blokowane hosty: x.com');
  });

  it('renders English from the English fields', async () => {
    const block = renderSourcesDoc(await loadSourceRegister(), await loadForbiddenTools(), 'en');
    expect(block).toContain('### RED sources');
    expect(block).toContain('### Forbidden tools');
    expect(block).toContain('no published terms');
    expect(block).not.toContain('Źródło');
  });

  it('replaces only the generated block and keeps the prose', () => {
    const doc = `intro\n${DOC_START}\nold\n${DOC_END}\noutro\n`;
    const next = replaceGeneratedBlock(doc, 'NEW');
    expect(next).toBe(`intro\n${DOC_START}\n\nNEW\n\n${DOC_END}\noutro\n`);
    expect(replaceGeneratedBlock(next, 'NEW')).toBe(next);
    expect(() => replaceGeneratedBlock('no markers', 'x')).toThrow(/needs/);
  });

  it('--check exits 1 naming the file when the register changed, --write fixes it', async () => {
    const dir = await temp();
    const sources = join(dir, 'sources.yaml');
    const doc = join(dir, 'sources.md');
    const original = await readFile(DEFAULT_SOURCES_PATH, 'utf8');
    await writeFile(sources, original);
    await writeFile(doc, `# Test\n${DOC_START}\n${DOC_END}\n`);
    const options = { sourcesPath: sources, toolsPath: DEFAULT_FORBIDDEN_TOOLS_PATH, out: doc };
    expect(await writeSourcesDoc(options)).toBe(true);
    expect((await checkSourcesDoc(options)).upToDate).toBe(true);
    await writeFile(
      sources,
      original.replace('rateLimit: { requests: 3, perSeconds: 1 }', 'rateLimit: { requests: 4, perSeconds: 1 }'),
    );
    const result = await checkSourcesDoc(options);
    expect(result).toEqual({ path: doc, upToDate: false });
    expect(await writeSourcesDoc(options)).toBe(true);
    expect((await readFile(doc, 'utf8')).startsWith('# Test\n')).toBe(true);
    expect((await checkSourcesDoc(options)).upToDate).toBe(true);
  });

  it('the CLI: passes on a clean checkout, exits 1 on a stale file, writes English to --out', async () => {
    expect(run('--check').status).toBe(0);
    const dir = await temp();
    const stale = join(dir, 'sources.md');
    await writeFile(stale, `${DOC_START}\nstale\n${DOC_END}\n`);
    const failed = run('--check', '--out', stale);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(stale);
    const english = join(dir, 'sources-en.md');
    expect(run('--write', '--lang', 'en', '--out', english).status).toBe(0);
    expect(await readFile(english, 'utf8')).toContain('### Forbidden tools');
    expect(run('--write', '--lang', 'en').status).toBe(2);
  });
});
