/**
 * Collection for one run: plans tasks from the case identifiers, runs them one at a time (politeness, determinism)
 * and expands each result up to the case's `maxPivotDepth`. Returns everything the pipeline persists plus the plan
 * with reasons and a per-source outcome for the UI.
 */
import type {
  Capture,
  CollectorResult,
  FetchMode,
  Id,
  Identifier,
  Observation,
  OnlineAccount,
  RunContext,
  SecretRedactor,
  SourceId,
} from '@olcys/core';
import { nowIso } from '@olcys/core';
import { CollectorRegistry, runCollector } from '../framework/collector-registry.ts';
import type { CollectorConfig, Env } from '../framework/config.ts';
import { SourceCircuitBreaker, type CollectorDeps, type RobotsPolicy } from '../framework/http.ts';
import type { ResolvedScope, SourceRegistry } from '../framework/source-registry.ts';
import { isBarrierStatus, rollupOutcomes, type CollectorStatus } from '../framework/status.ts';
import { createClassifiedAdsCollector } from '../platforms/classified-ads.ts';
import { createBitcointalkCollector } from '../platforms/bitcointalk.ts';
import { createCeidgCollector } from '../registries/ceidg.ts';
import { createKrsCollector } from '../registries/krs.ts';
import { createVatWhitelistCollector } from '../registries/vat-whitelist.ts';
import { createGithubCollector } from '../platforms/code-hosting.ts';
import { createWykopCollector } from '../platforms/social-profile.ts';
import { createTelegramCollector } from '../platforms/telegram.ts';
import { searchCollectorFactories } from '../search/mode.ts';
import {
  accountAliasKeys,
  DEFAULT_MAX_TASKS,
  planExpansion,
  planInitial,
  PIVOT_RULES_VERSION,
  type PlannedTask,
  type PlannerContext,
  type SkippedTask,
} from './planner.ts';

/**
 * Forum, social profile, code hosting, channel previews and P2P ads (fixture), the Polish public registries, in
 * planning order, then the web search collectors of `OLCYS_SEARCH_MODE` (default: the mock search over the fixture
 * site). CEIDG needs the institution's token (`CEIDG_API_TOKEN`) in live mode and is not registered without it;
 * offline and in replay it reads the synthetic fixture site and needs none.
 */
export function createDefaultCollectorRegistry(options: { mode?: FetchMode; env?: Env } = {}): CollectorRegistry {
  const registry = new CollectorRegistry()
    .register(createBitcointalkCollector())
    .register(createWykopCollector())
    .register(createGithubCollector())
    .register(createTelegramCollector())
    .register(createClassifiedAdsCollector())
    .register(createVatWhitelistCollector())
    .register(createKrsCollector());
  const ceidgToken = options.env?.['CEIDG_API_TOKEN']?.trim();
  if ((options.mode ?? 'offline') !== 'live' || ceidgToken) {
    registry.register(createCeidgCollector({ token: ceidgToken }));
  }
  for (const factory of searchCollectorFactories({ mode: options.mode ?? 'offline', env: options.env ?? {} })) {
    registry.register(factory);
  }
  return registry;
}

export interface CollectCaseOptions {
  identifiers: readonly Identifier[];
  /** `sources.resolveScope(case.scope, mode)`; its `egressSources` configure the run's egress client. */
  scope: ResolvedScope;
  sources: SourceRegistry;
  /** `http` is the run's egress client; `mode` must equal `scope.mode`. */
  ctx: RunContext;
  config: CollectorConfig;
  /** robots.txt policy over the same egress client (`new RobotsCache(http, userAgent)`). */
  robots: RobotsPolicy;
  /** Removes private keys and seed phrases from every body before storage and parsing (required). */
  redactor: SecretRedactor;
  maxPivotDepth: number;
  /** Default: `createDefaultCollectorRegistry({ mode: ctx.mode, env })`. */
  collectors?: CollectorRegistry;
  /** Environment of the default registry's search collectors (`OLCYS_SEARCH_MODE`, API keys); default: mock search. */
  env?: Env;
  maxTasks?: number;
  /** Called after each task (progress for the UI). */
  onTask?: (event: { done: number; planned: number; task: TaskRecord }) => void | Promise<void>;
}

export interface TaskRecord extends Omit<PlannedTask, 'input'> {
  status: CollectorStatus;
  notes: string[];
  captureIds: Id[];
  accountIds: Id[];
  observationCount: number;
  startedAt: string;
  finishedAt: string;
}

export interface SourceOutcome {
  sourceId: SourceId;
  status: CollectorStatus;
  tasks: number;
  captures: number;
  notes: string[];
}

export interface CollectCaseResult {
  rulesVersion: string;
  tasks: TaskRecord[];
  skipped: SkippedTask[];
  captures: Capture[];
  accounts: OnlineAccount[];
  observations: Observation[];
  sources: SourceOutcome[];
  /** Some source could not be read (barrier or error): the run is `partial`. */
  partial: boolean;
}

export async function collectCase(options: CollectCaseOptions): Promise<CollectCaseResult> {
  const { ctx, scope } = options;
  if (ctx.mode !== scope.mode) throw new Error(`run mode ${ctx.mode} differs from the scope mode ${scope.mode}`);
  const registry =
    options.collectors ??
    createDefaultCollectorRegistry({ mode: ctx.mode, ...(options.env ? { env: options.env } : {}) });
  const deps: CollectorDeps = {
    mode: ctx.mode,
    config: options.config,
    robots: options.robots,
    breaker: new SourceCircuitBreaker(),
    redactor: options.redactor,
  };
  const planner: PlannerContext = {
    scope,
    factories: registry.list(),
    collectors: registry.forScope(scope, options.sources, deps),
    known: new Set(),
    maxPivotDepth: options.maxPivotDepth,
    maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
    counter: { planned: 0 },
    watchList: options.config.watchList,
    fixture: options.config.fixture,
    identifiers: options.identifiers.filter((i) => i.value.trim()),
  };
  for (const justification of Object.entries(scope.amberJustifications)) {
    ctx.logger.info('AMBER source enabled for the case', {
      sourceId: justification[0],
      justification: justification[1],
    });
  }

  const initial = planInitial(options.identifiers, planner);
  const queue: PlannedTask[] = [...initial.tasks];
  const skipped: SkippedTask[] = [...initial.skipped];
  const tasks: TaskRecord[] = [];
  const captures: Capture[] = [];
  const accounts: OnlineAccount[] = [];
  const observations: Observation[] = [];
  /** Task keys covered by accounts already collected in this run (handle and stable-id aliases). */
  const covered = new Set<string>();

  // Breadth-first and strictly sequential: one request at a time, deterministic order.
  for (let task = queue.shift(); task; task = queue.shift()) {
    ctx.signal?.throwIfAborted();
    if (covered.has(task.key)) {
      // Queued before the account was known under this key (e.g. a nick and its profile URL as inputs).
      const { key, sourceId, platform, subjectKey, depth, provenance } = task;
      skipped.push({ key, sourceId, platform, subjectKey, depth, provenance, skip: 'already_collected' });
      continue;
    }
    const instance = planner.collectors.get(task.sourceId);
    if (!instance) throw new Error(`planned task without collector: ${task.key}`);
    const startedAt = nowIso(ctx.clock);
    // oxlint-disable-next-line no-await-in-loop
    const result: CollectorResult = await runCollector(instance.collector, task.input, ctx, scope, deps);
    covered.add(task.key);
    for (const account of result.accounts) {
      const owner = planner.factories.find((f) => f.platform === account.platform);
      if (owner) for (const alias of accountAliasKeys(owner.sourceId, account)) covered.add(alias);
    }
    captures.push(...result.captures);
    accounts.push(...result.accounts);
    observations.push(...result.observations);
    const { key, sourceId, platform, subjectKey, depth, provenance } = task;
    const record: TaskRecord = {
      key,
      sourceId,
      platform,
      subjectKey,
      depth,
      provenance,
      status: result.status,
      notes: result.notes,
      captureIds: result.captures.map((c) => c.id),
      accountIds: result.accounts.map((a) => a.id),
      observationCount: result.observations.length,
      startedAt,
      finishedAt: nowIso(ctx.clock),
    };
    tasks.push(record);
    const next = planExpansion(task, result, planner);
    queue.push(...next.tasks);
    skipped.push(...next.skipped);
    // oxlint-disable-next-line no-await-in-loop
    await options.onTask?.({ done: tasks.length, planned: planner.counter.planned, task: record });
  }

  const bySource = new Map<SourceId, TaskRecord[]>();
  for (const t of tasks) bySource.set(t.sourceId, [...(bySource.get(t.sourceId) ?? []), t]);
  const sources: SourceOutcome[] = [...bySource.entries()].map(([sourceId, list]) => ({
    sourceId,
    status: rollupOutcomes(list.map((t) => t.status)),
    tasks: list.length,
    captures: list.reduce((n, t) => n + t.captureIds.length, 0),
    notes: list.flatMap((t) => t.notes),
  }));
  const partial = tasks.some((t) => t.status === 'error' || t.status === 'partial' || isBarrierStatus(t.status));
  return { rulesVersion: PIVOT_RULES_VERSION, tasks, skipped, captures, accounts, observations, sources, partial };
}
