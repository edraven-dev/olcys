/**
 * Composition root: wires the repository, blob-store and pipeline implementations behind the `@olcys/core` ports.
 * The API process uses it to run analyses in-process (MVP); stages are registered by the caller.
 */
import { join } from 'node:path';
import type { FetchMode, Logger, Repositories, RunWithProgress, SourceDescriptor } from '@olcys/core';
import { createDb, createMemoryRepositories, createSqlRepositories } from '@olcys/db';
import { FileBlobStore, InMemoryBlobStore } from '@olcys/evidence';
import type { BlobStore } from '@olcys/core';
import { loadConfig, REPO_ROOT, type LoadedConfig } from './config.ts';
import { createRun, runPipeline, type Stage } from './pipeline.ts';

export interface Runtime {
  repos: Repositories;
  blobs: BlobStore;
  sources: SourceDescriptor[];
  config: LoadedConfig;
  mode: FetchMode;
  logger: Logger;
  startRun(
    caseId: string,
    input: { trigger?: 'manual' | 'rescore'; rescoreOfRunId?: string },
  ): Promise<RunWithProgress>;
  /** Resolves when every run started by this runtime has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  stages?: (runtime: Pick<Runtime, 'repos' | 'blobs' | 'sources' | 'config' | 'mode' | 'logger'>) => Stage[];
  repos?: Repositories;
  blobs?: BlobStore;
  logger?: Logger;
}

export function consoleLogger(scope: string): Logger {
  const line = (level: string, message: string, data?: Record<string, unknown>) =>
    `[${scope}] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ''}`;
  return {
    debug: (m, d) => console.debug(line('debug', m, d)),
    info: (m, d) => console.info(line('info', m, d)),
    warn: (m, d) => console.warn(line('warn', m, d)),
    error: (m, d) => console.error(line('error', m, d)),
  };
}

const noop = async (): Promise<void> => {};

function modeFrom(value: string | undefined): FetchMode {
  if (value === 'live' || value === 'replay') return value;
  return 'offline';
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? consoleLogger('olcys');
  const config = await loadConfig();
  const mode = modeFrom(env['OLCYS_MODE']);

  let closeDb: () => Promise<void> = noop;
  let repos = options.repos;
  if (!repos) {
    const url = env['DATABASE_URL'];
    if (url) {
      const db = createDb(url);
      repos = createSqlRepositories(db);
      closeDb = () => db.destroy();
    } else {
      logger.warn('DATABASE_URL not set: using the in-memory store (data is lost on exit)');
      repos = createMemoryRepositories();
    }
  }
  const dataDir = env['OLCYS_DATA_DIR'] ?? join(REPO_ROOT, 'data');
  const blobs =
    options.blobs ??
    (env['OLCYS_BLOBS'] === 'memory' ? new InMemoryBlobStore() : new FileBlobStore(join(dataDir, 'blobs')));

  const base = { repos, blobs, sources: config.sources, config, mode, logger };
  const stages = options.stages?.(base) ?? [];
  const running = new Set<Promise<unknown>>();

  return {
    ...base,
    async startRun(caseId, input) {
      const run = await createRun(repos, { caseId, mode, ...input }, config.snapshot);
      const job = runPipeline(run.id, { repos, blobs, logger, stages })
        .catch((error: unknown) => logger.error('pipeline crashed', { runId: run.id, error: String(error) }))
        .finally(() => running.delete(job));
      running.add(job);
      const created = await repos.runs.get(run.id);
      if (!created) throw new Error(`run ${run.id} not stored`);
      return created;
    },
    async idle() {
      await Promise.all(running);
    },
    async close() {
      await Promise.all(running);
      await closeDb();
    },
  };
}
