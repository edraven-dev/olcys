/**
 * Composition root: wires the repository, blob-store and pipeline implementations behind the `@olcys/core` ports.
 * The API process uses it to run analyses in-process (MVP); stages are registered by the caller.
 */
import { join } from 'node:path';
import type { FetchMode, LlmClient, Logger, Repositories, RunWithProgress, SourceDescriptor } from '@olcys/core';
import { createDb, createMemoryRepositories, createSqlRepositories } from '@olcys/db';
import { FileBlobStore, InMemoryBlobStore } from '@olcys/evidence';
import type { BlobStore } from '@olcys/core';
import { loadConfig, REPO_ROOT, type LoadedConfig } from './config.ts';
import { createLlmRuntime, llmSnapshot } from './llm.ts';
import { createRun, runPipeline, type Stage } from './pipeline.ts';
import { createTrustedTimestamper, tsaSettings, type WorkerTimestamper } from './timestamper.ts';

export interface Runtime {
  repos: Repositories;
  blobs: BlobStore;
  sources: SourceDescriptor[];
  config: LoadedConfig;
  mode: FetchMode;
  logger: Logger;
  /** RFC 3161 timestamping of capture manifests (live: stamps; offline/replay: queues; see `TSA_ENABLED`). */
  timestamper: WorkerTimestamper;
  /** The AI model (suggestions only); `enabled` is false unless `LLM_ENABLED=true`. */
  llm: LlmClient;
  startRun(
    caseId: string,
    input: { trigger?: 'manual' | 'rescore'; rescoreOfRunId?: string },
  ): Promise<RunWithProgress>;
  /**
   * Runs the pipeline of a queued run created elsewhere, without waiting: the scheduler stores a scheduled run together
   * with the tick that started it.
   */
  launchRun(runId: string): void;
  /** Resolves when every run started by this runtime has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  stages?: (
    runtime: Pick<Runtime, 'repos' | 'blobs' | 'sources' | 'config' | 'mode' | 'logger' | 'timestamper' | 'llm'>,
  ) => Stage[];
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
  const loaded = await loadConfig();
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

  // Fails the start-up when the TSA host is not allow-listed (`tsa_host_not_allow_listed`) or the anchors are unreadable.
  let timestamper: WorkerTimestamper;
  try {
    timestamper = await createTrustedTimestamper({
      repos,
      blobs,
      settings: tsaSettings(env),
      sources: loaded.sources,
      mode,
      logger,
    });
  } catch (error) {
    await closeDb();
    throw error;
  }
  const llmRuntime = createLlmRuntime({ env, repos, blobs, sources: loaded.sources, mode });
  const llm = llmRuntime.client;
  // The model identity is part of every run's snapshot, so a result can be tied to the exact model that suggested.
  const config: LoadedConfig = { ...loaded, snapshot: { ...loaded.snapshot, llm: llmSnapshot(llmRuntime.config) } };
  const base = { repos, blobs, sources: config.sources, config, mode, logger, timestamper, llm };
  const stages = options.stages?.(base) ?? [];
  const running = new Set<Promise<unknown>>();
  const launchRun = (runId: string): void => {
    const job = runPipeline(runId, { repos, blobs, logger, stages })
      .catch(async (error: unknown) => {
        // The pipeline ends its own failures as `failed`; this covers what it could not even start (run unreadable).
        logger.error('pipeline crashed', { runId, error: String(error) });
        const message = error instanceof Error ? error.message : String(error);
        await repos.runs
          .update(runId, { status: 'failed', finishedAt: new Date().toISOString(), error: message })
          .catch((updateError: unknown) =>
            logger.error('run could not be marked failed', { runId, error: String(updateError) }),
          );
      })
      .finally(() => running.delete(job));
    running.add(job);
  };

  return {
    ...base,
    async startRun(caseId, input) {
      const run = await createRun(repos, { caseId, mode, ...input }, config.snapshot);
      launchRun(run.id);
      const created = await repos.runs.get(run.id);
      if (!created) throw new Error(`run ${run.id} not stored`);
      return created;
    },
    launchRun,
    async idle() {
      await Promise.all(running);
    },
    async close() {
      await Promise.all(running);
      await closeDb();
    },
  };
}
