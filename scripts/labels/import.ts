/**
 * `pnpm labels:import <datasetId> <file> [options]`: imports an open label dataset from a local file (offline).
 * Address datasets (graphsense-tagpacks, ofac-0xb10c, por-file, eth-labels) go to the label store (DATABASE_URL);
 * entity registers (esma-casps, pl-vasp-register) are written as JSON under `${OLCYS_DATA_DIR}/entities/`.
 * Every import is checked against config/labels/datasets.v1.yaml; refused datasets never import. Re-importing the
 * same content is a no-op (the store ignores a label whose content it already holds).
 *
 *   --version <v>        git commit, snapshot date or report date (default: today, UTC)
 *   --profile <name>     por-file: profile of config/labels/por-profiles.v1.yaml
 *   --actors <file>      graphsense-tagpacks: ActorPack YAML
 *   --confidence <file>  graphsense-tagpacks: graphsense-lib confidence.csv (default: the pinned subset in config)
 *   --asset <ASSET>      ofac-0xb10c: asset (default: from the file name sanctioned_addresses_<ASSET>.json)
 *   --justification <t>  required for datasets that are disabled by default (eth-labels)
 *   --dry-run            parse and report, write nothing
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AddressLabel, LabelRepository } from '../../packages/core/src/index.ts';
import { createDb, createSqlRepositories } from '../../packages/db/src/index.ts';
import {
  checkImportPolicy,
  diffOfacVersions,
  importContext,
  loadDatasetRegistry,
  loadPorProfiles,
  parseActorPack,
  parseConfidenceCsv,
  parseEsmaCasps,
  parseOfacList,
  parsePlRegister,
  parsePorCsv,
  parseTagPack,
  readEthLabels,
  type EntityFile,
  type PositionedText,
} from '../../packages/labels/src/index.ts';

const ROOT = new URL('../../', import.meta.url);
const config = (name: string): Promise<string> => readFile(new URL(`config/labels/${name}`, ROOT), 'utf8');

export interface ImportOptions {
  datasetId: string;
  file: string;
  version?: string;
  profile?: string;
  actors?: string;
  confidence?: string;
  asset?: string;
  justification?: string;
  dryRun?: boolean;
}

export interface ImportDeps {
  labels: LabelRepository | undefined;
  dataDir: string;
  now: () => Date;
}

export type ImportOutcome =
  | { status: 'refused'; reason: string; message: string }
  | {
      status: 'imported';
      datasetId: string;
      version: string;
      contentSha256: string;
      count: number;
      target: string;
      warnings: string[];
    };

export async function runImport(options: ImportOptions, deps: ImportDeps): Promise<ImportOutcome> {
  const policy = checkImportPolicy(
    loadDatasetRegistry(await config('datasets.v1.yaml')),
    options.datasetId,
    options.justification ? { justification: options.justification } : {},
  );
  if (!policy.ok) return { status: 'refused', reason: policy.reason, message: policy.message };
  const { entry } = policy;
  const retrievedAt = deps.now().toISOString();
  const version = options.version ?? retrievedAt.slice(0, 10);
  const bytes = await readFile(options.file);
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8');
  const ctx = importContext(entry, {
    version,
    retrievedAt,
    lastmod: /^\d{4}-\d{2}-\d{2}$/.test(version) ? `${version}T00:00:00.000Z` : retrievedAt,
  });

  let labels: AddressLabel[] = [];
  let warnings: string[] = [];
  switch (entry.datasetId) {
    case 'graphsense-tagpacks': {
      const actors = parseActorPack(options.actors ? await readFile(options.actors, 'utf8') : 'actors: []');
      const confidence = parseConfidenceCsv(
        options.confidence ? await readFile(options.confidence, 'utf8') : await config('tagpack-confidence.v1.csv'),
      );
      ({ rows: labels, warnings } = parseTagPack(text, ctx, { actors, confidence }));
      break;
    }
    case 'ofac-0xb10c': {
      const asset = (
        options.asset ??
        /sanctioned_addresses_([A-Za-z]+)\.json$/.exec(options.file)?.[1] ??
        ''
      ).toUpperCase();
      if (!asset) throw new Error('ofac-0xb10c: pass --asset or name the file sanctioned_addresses_<ASSET>.json');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) throw new Error('ofac-0xb10c: --version must be the snapshot date');
      const parsed = parseOfacList(asset, text, ctx);
      warnings = parsed.warnings;
      // Each asset file has its own history: compare only with the labels of this dataset and asset.
      const previous = deps.labels
        ? (await deps.labels.list()).filter(
            (l) => l.provenance.datasetId === entry.datasetId && l.provenance.asset === asset,
          )
        : undefined;
      const latest = (previous ?? []).map((l) => l.provenance.version ?? '').reduce((a, b) => (b > a ? b : a), '');
      if (version < latest) {
        throw new Error(
          `ofac-0xb10c ${asset}: snapshot ${version} is older than the latest imported snapshot ${latest}; import snapshots in date order`,
        );
      }
      labels = diffOfacVersions(previous, parsed.rows, version);
      break;
    }
    case 'por-file': {
      const profile = loadPorProfiles(await config('por-profiles.v1.yaml'))[options.profile ?? ''];
      if (!profile) throw new Error('por-file: pass --profile <name> (see config/labels/por-profiles.v1.yaml)');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) throw new Error('por-file: --version must be the report date');
      const datasetId = `${options.profile}-por`;
      ({ rows: labels, warnings } = parsePorCsv(text, profile, { ...ctx, datasetId }));
      break;
    }
    case 'eth-labels':
      ({ rows: labels, warnings } = readEthLabels(options.file, ctx));
      break;
    case 'esma-casps':
    case 'pl-vasp-register': {
      const parsed =
        entry.datasetId === 'esma-casps' ? parseEsmaCasps(text) : parsePlRegister(JSON.parse(text) as PositionedText[]);
      const file: EntityFile = {
        registry: entry.datasetId === 'esma-casps' ? 'esma_casps' : 'pl_vasp',
        datasetId: entry.datasetId,
        version,
        retrievedAt,
        contentSha256,
        license: entry.license,
        records: parsed.records,
      };
      const target = join(deps.dataDir, 'entities', `${file.registry}.json`);
      if (!options.dryRun) {
        await mkdir(join(deps.dataDir, 'entities'), { recursive: true });
        await writeFile(target, `${JSON.stringify(file, null, 2)}\n`);
      }
      return {
        status: 'imported',
        datasetId: entry.datasetId,
        version,
        contentSha256,
        count: parsed.records.length,
        target,
        warnings: parsed.warnings,
      };
    }
    default:
      throw new Error(`no importer for dataset ${entry.datasetId}`);
  }
  if (!options.dryRun) {
    if (!deps.labels) throw new Error('DATABASE_URL is not set (copy .env.example to .env), or use --dry-run');
    await deps.labels.upsert(labels);
  }
  return {
    status: 'imported',
    datasetId: entry.datasetId,
    version,
    contentSha256,
    count: labels.length,
    target: 'label store',
    warnings,
  };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      profile: { type: 'string' },
      actors: { type: 'string' },
      confidence: { type: 'string' },
      asset: { type: 'string' },
      justification: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const [datasetId, file] = positionals;
  if (!datasetId || !file) {
    console.error(
      'usage: pnpm labels:import <datasetId> <file> [--version v] [--profile p] [--justification text] [--dry-run]',
    );
    process.exit(2);
  }
  const url = process.env['DATABASE_URL'];
  const db = url && !values['dry-run'] ? createDb(url, { max: 1 }) : undefined;
  try {
    const outcome = await runImport(
      {
        datasetId,
        file,
        dryRun: values['dry-run'] === true,
        ...(values.version ? { version: values.version } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.actors ? { actors: values.actors } : {}),
        ...(values.confidence ? { confidence: values.confidence } : {}),
        ...(values.asset ? { asset: values.asset } : {}),
        ...(values.justification ? { justification: values.justification } : {}),
      },
      {
        labels: db ? createSqlRepositories(db).labels : undefined,
        dataDir: process.env['OLCYS_DATA_DIR'] ?? 'data',
        now: () => new Date(),
      },
    );
    if (outcome.status === 'refused') {
      console.error(outcome.message);
      process.exitCode = 1;
    } else {
      for (const w of outcome.warnings) console.warn(`warning: ${w}`);
      console.info(
        `imported ${outcome.count} record(s) from ${basename(file)}: ${outcome.datasetId} version ${outcome.version}, sha256 ${outcome.contentSha256}, into ${outcome.target}`,
      );
    }
  } catch (error) {
    console.error(`import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await db?.destroy();
  }
}
