/**
 * Synthetic extraction corpus generator (offline, deterministic).
 *
 *   node scripts/corpus/generate.ts               regenerate fixtures/corpus (the templates are the input)
 *   node scripts/corpus/generate.ts --check       regenerate in memory and report drift against the files (exit 1)
 *   node scripts/corpus/generate.ts --out <dir>   write the generated files into <dir> instead
 *   --seed <seed>                                 seed (default: the committed manifest's seed)
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CORPUS_DIR } from '../../bench/corpus.ts';
import { DEFAULT_SEED, GENERATED_DIRS, GENERATED_FILES, generateCorpus } from './lib/corpus.ts';

async function listGenerated(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of GENERATED_DIRS) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    // oxlint-disable-next-line no-await-in-loop
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
    }
  }
  for (const file of GENERATED_FILES) if (existsSync(join(dir, file))) out.push(file);
  return out.toSorted();
}

/** Seed recorded in the corpus manifest, if any. */
export async function committedSeed(dir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { seed?: unknown };
    return typeof manifest.seed === 'string' ? manifest.seed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Paths whose content differs from a fresh generation (missing, changed or stale). */
export async function corpusDrift(dir: string, seed?: string): Promise<string[]> {
  const generated = await generateCorpus({ corpusDir: dir, seed: seed ?? (await committedSeed(dir)) ?? DEFAULT_SEED });
  const drift: string[] = [];
  for (const [path, text] of generated.files) {
    const file = join(dir, path);
    // oxlint-disable-next-line no-await-in-loop
    if (!existsSync(file) || (await readFile(file, 'utf8')) !== text) drift.push(path);
  }
  for (const path of await listGenerated(dir)) if (!generated.files.has(path)) drift.push(`${path} (stale)`);
  return drift.toSorted();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { check: { type: 'boolean', default: false }, out: { type: 'string' }, seed: { type: 'string' } },
  });
  if (values.check) {
    const drift = await corpusDrift(DEFAULT_CORPUS_DIR, values.seed);
    if (drift.length > 0) {
      console.error(
        `corpus drift (${drift.length} files) — run corpus:generate:\n  ${drift.slice(0, 40).join('\n  ')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('corpus is up to date');
    return;
  }
  const seed = values.seed ?? (await committedSeed(DEFAULT_CORPUS_DIR)) ?? DEFAULT_SEED;
  const generated = await generateCorpus({ corpusDir: DEFAULT_CORPUS_DIR, seed });
  const target = values.out ? resolve(values.out) : DEFAULT_CORPUS_DIR;
  if (!values.out) {
    for (const path of await listGenerated(target)) {
      // oxlint-disable-next-line no-await-in-loop
      if (!generated.files.has(path)) await rm(join(target, path));
    }
  }
  for (const [path, text] of generated.files) {
    const file = join(target, path);
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(dirname(file), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(file, text);
  }
  const { counts } = generated.manifest;
  console.log(
    `corpus written to ${target}: ${Object.values(counts.documents).reduce((a, b) => a + b, 0)} documents, ` +
      `${counts.truthRows} labelled occurrences, seed ${seed}`,
  );
}

if (import.meta.main) await main();
