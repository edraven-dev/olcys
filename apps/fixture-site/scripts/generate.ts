/**
 * Offline generator of the synthetic fixture site (never run in CI except `--check`).
 *
 *   node scripts/generate.ts                 new keys → manifest, test vectors, labels → render public/
 *   node scripts/generate.ts --render-only   re-render public/ and labels from the existing manifest (no keys)
 *   node scripts/generate.ts --check         render into memory and report drift against public/ (exit 1)
 *   --out <dir>                              write <dir>/public, <dir>/persona, <dir>/labels instead (tests)
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PersonaManifest } from '../src/manifest.ts';
import { SYNTHETIC_MARK } from './lib/chain.ts';
import { identityFixtures } from './lib/identity.ts';
import { chainFor, createWorld, labelsFor, routesFor, tokensFor, type World } from './lib/persona.ts';
import { renderSitemap } from './lib/sitemap.ts';
import { renderTemplate } from './lib/template.ts';
import { waybackFiles } from './lib/wayback.ts';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..', '..');
const TEMPLATES = join(APP, 'templates');
const VARIANTS = ['v1', 'v2'] as const;

export interface Paths {
  publicDir: string;
  personaDir: string;
  labelsDir: string;
}

export function pathsFor(out?: string): Paths {
  if (out) return { publicDir: join(out, 'public'), personaDir: join(out, 'persona'), labelsDir: join(out, 'labels') };
  return {
    publicDir: join(APP, 'public'),
    personaDir: join(REPO, 'fixtures', 'persona'),
    labelsDir: join(REPO, 'fixtures', 'labels'),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .toSorted();
}

/** Every file under public/, keyed `<shared|v1|v2>/<path>`. */
export async function renderSite(manifest: World['manifest']): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const rel of await walk(join(TEMPLATES, 'shared'))) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await readFile(join(TEMPLATES, 'shared', rel), 'utf8');
    files.set(`shared/${rel}`, renderTemplate(text, tokensFor(manifest, 'shared'), rel));
  }
  const variantTemplates = await walk(join(TEMPLATES, 'variant'));
  for (const variant of VARIANTS) {
    for (const rel of variantTemplates) {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(TEMPLATES, 'variant', rel), 'utf8');
      files.set(`${variant}/${rel}`, renderTemplate(text, tokensFor(manifest, variant), rel));
    }
  }
  for (const [path, content] of waybackFiles(files)) files.set(path, content);
  const chain = chainFor(manifest);
  for (const file of chain.files) files.set(`shared/${file.path}`, file.content);
  const identity = identityFixtures(manifest.seed);
  for (const file of identity.files) files.set(`shared/${file.path}`, file.content);
  files.set(
    'shared/routes.json',
    json({ _synthetic: SYNTHETIC_MARK, routes: routesFor([...chain.routes, ...identity.routes]) }),
  );
  for (const variant of VARIANTS) files.set(`${variant}/sitemap.xml`, renderSitemap(manifest.pages, variant));
  return new Map([...files.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

async function writeAll(base: string, files: Map<string, string>): Promise<void> {
  for (const [path, content] of files) {
    const target = join(base, path);
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(dirname(target), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(target, content);
  }
}

async function writeSite(paths: Paths, manifest: World['manifest']): Promise<PersonaManifest> {
  const site = await renderSite(manifest);
  for (const dir of ['shared', ...VARIANTS]) {
    // oxlint-disable-next-line no-await-in-loop
    await rm(join(paths.publicDir, dir), { recursive: true, force: true });
  }
  await writeAll(paths.publicDir, site);
  const full: PersonaManifest = {
    ...manifest,
    files: Object.fromEntries([...site].map(([path, content]) => [path, sha256(content)])),
  };
  await mkdir(paths.personaDir, { recursive: true });
  await mkdir(paths.labelsDir, { recursive: true });
  await writeFile(join(paths.personaDir, 'manifest.json'), json(full));
  await writeFile(join(paths.labelsDir, 'demo-curated.json'), json(labelsFor(manifest)));
  return full;
}

export async function generate(paths: Paths, now = new Date()): Promise<PersonaManifest> {
  const world = createWorld(now);
  await mkdir(paths.personaDir, { recursive: true });
  await writeFile(join(paths.personaDir, 'test-vectors.json'), json(world.testVectors));
  return writeSite(paths, world.manifest);
}

export async function loadManifest(paths: Paths): Promise<PersonaManifest> {
  return JSON.parse(await readFile(join(paths.personaDir, 'manifest.json'), 'utf8')) as PersonaManifest;
}

export async function renderOnly(paths: Paths): Promise<PersonaManifest> {
  return writeSite(paths, await loadManifest(paths));
}

/** Differences between what the manifest renders to and what is on disk; empty when in sync. */
export async function check(paths: Paths): Promise<string[]> {
  const manifest = await loadManifest(paths);
  const site = await renderSite(manifest);
  const drift: string[] = [];
  const onDisk = new Set(await walk(paths.publicDir));
  for (const [path, content] of site) {
    if (!onDisk.has(path)) {
      drift.push(`missing: public/${path}`);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    if ((await readFile(join(paths.publicDir, path), 'utf8')) !== content) drift.push(`changed: public/${path}`);
    if (manifest.files[path] !== sha256(content)) drift.push(`manifest hash: public/${path}`);
  }
  for (const path of onDisk) if (!site.has(path)) drift.push(`unexpected: public/${path}`);
  for (const path of Object.keys(manifest.files)) if (!site.has(path)) drift.push(`manifest lists: public/${path}`);
  let labels = '';
  try {
    labels = await readFile(join(paths.labelsDir, 'demo-curated.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (labels !== json(labelsFor(manifest))) drift.push('changed: fixtures/labels/demo-curated.json');
  return drift;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'render-only': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const paths = pathsFor(values.out);
  if (values.check) {
    const drift = await check(paths);
    if (drift.length) {
      console.error(`fixture drift (re-render with --render-only):\n  ${drift.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.info('fixtures in sync');
    }
  } else if (values['render-only']) {
    const manifest = await renderOnly(paths);
    console.info(`rendered ${Object.keys(manifest.files).length} files`);
  } else {
    const manifest = await generate(paths);
    console.info(
      `generated persona fixtures: ${Object.keys(manifest.addresses).length} addresses, ${Object.keys(manifest.files).length} files`,
    );
  }
}
