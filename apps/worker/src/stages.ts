/**
 * The pipeline stages of the MVP: each adapts one package to the pipeline and stores its results through the
 * repository ports. All network access goes through one egress client per run (allow-list, robots.txt, egress log and
 * provenance written to the store); page bodies are redacted before they are stored.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock, FetchMode, SourceDescriptor } from '@olcys/core';
import { newId } from '@olcys/core';
import { createSecretRedactor, extractCapture, parseDenyList, type CaptureContent } from '@olcys/address-extractor';
import { collectCase, loadCollectorConfig, loadSourceRegistry, type SourceRegistry } from '@olcys/collectors';
import { createEgressClient, RobotsCache } from '@olcys/http';
import { loadWeights, scoreRun } from '@olcys/scoring';
import { REPO_ROOT, TOOL_VERSION } from './config.ts';
import type { Stage, StageContext } from './pipeline.ts';

export const USER_AGENT = `OLCYS/${TOOL_VERSION} (OSINT research prototype; synthetic demo)`;
const TEXT_ARTIFACTS = new Set(['html', 'json', 'text']);
const systemClock: Clock = { now: () => new Date() };

export interface StageOptions {
  mode: FetchMode;
  /** Environment for collector configuration (fixture base URL, watch pages) and cassettes. */
  env?: Readonly<Record<string, string | undefined>>;
  sources: readonly SourceDescriptor[];
}

/** Loads once per process; a rejected load is retried by the next run. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export function createCollectStage(options: StageOptions): Stage {
  const registry = lazy<SourceRegistry>(() => loadSourceRegistry());
  const redactor = createSecretRedactor();
  const env = options.env ?? process.env;
  return {
    step: 'collect.source',
    async run(ctx: StageContext) {
      const sources = await registry();
      const scope = sources.resolveScope(ctx.case.scope, options.mode);
      const cassetteSet = env['OLCYS_CASSETTE_SET'];
      const http = createEgressClient({
        mode: options.mode,
        runId: ctx.run.id,
        enabledSources: scope.egressSources,
        blobs: ctx.blobs,
        sinks: {
          log: (entry) => ctx.repos.evidence.addEgressLog([entry]),
          provenance: (envelope) => ctx.repos.evidence.addRawFetches([envelope]),
        },
        toolVersion: TOOL_VERSION,
        userAgent: USER_AGENT,
        ...(cassetteSet ? { cassetteDir: join(REPO_ROOT, 'fixtures', 'cassettes', cassetteSet) } : {}),
        record: env['OLCYS_RECORD'] === '1',
      });
      const config = await loadCollectorConfig({ mode: options.mode, env: { ...env } });
      const result = await collectCase({
        identifiers: ctx.case.identifiers,
        scope,
        sources,
        ctx: {
          runId: ctx.run.id,
          caseId: ctx.case.id,
          mode: options.mode,
          http,
          blobs: ctx.blobs,
          clock: systemClock,
          logger: ctx.logger,
        },
        config,
        robots: new RobotsCache(http, USER_AGENT),
        redactor,
        maxPivotDepth: ctx.case.scope.maxPivotDepth,
        onTask: (event) => ctx.progress({ tasksDone: event.done, tasksPlanned: event.planned }),
      });
      await ctx.repos.evidence.addCaptures(result.captures);
      await ctx.repos.evidence.addAccounts(result.accounts);
      await ctx.repos.evidence.addObservations(result.observations);
      if (result.partial) {
        const unavailable = result.sources.filter((s) => s.status !== 'ok' && s.status !== 'not_found');
        ctx.markPartial(`unavailable sources: ${unavailable.map((s) => s.sourceId).join(', ') || 'some pages'}`);
      }
      await ctx.progress({
        captures: result.captures.length,
        observations: result.observations.length,
        accounts: result.accounts.length,
        refusedSources: scope.refused.map((r) => r.sourceId),
      });
    },
  };
}

export function createExtractStage(): Stage {
  const denyList = lazy(async () =>
    parseDenyList(await readFile(join(REPO_ROOT, 'config', 'rules', 'deny-list.v1.yaml'), 'utf8')),
  );
  return {
    step: 'extract.capture',
    async run(ctx: StageContext) {
      const list = await denyList();
      const captures = (await ctx.repos.evidence.listCaptures(ctx.run.id)).filter((c) => c.status === 'ok');
      let candidates = 0;
      for (const capture of captures) {
        const artifacts: CaptureContent['artifacts'] = [];
        for (const artifact of capture.artifacts.filter((a) => TEXT_ARTIFACTS.has(a.kind))) {
          // Sequential on purpose: pages are processed one at a time to bound memory.
          // oxlint-disable-next-line no-await-in-loop
          const bytes = await ctx.blobs.get(artifact.blob.sha256);
          artifacts.push({ kind: artifact.kind, mediaType: artifact.blob.mediaType, bytes });
        }
        if (artifacts.length === 0) continue;
        // oxlint-disable-next-line no-await-in-loop
        const result = await extractCapture(
          { captureId: capture.id, url: capture.url, finalUrl: capture.finalUrl, artifacts },
          { denyList: list },
        );
        candidates += result.candidates.length;
        // oxlint-disable-next-line no-await-in-loop
        await ctx.repos.evidence.addExtraction(ctx.run.id, result);
      }
      await ctx.progress({ extracted: captures.length, candidates });
    },
  };
}

export function createScoreStage(options: Pick<StageOptions, 'sources'>): Stage {
  const weights = lazy(() => loadWeights());
  const byId = new Map(options.sources.map((s) => [s.id, s]));
  return {
    step: 'score.links',
    async run(ctx: StageContext) {
      const runId = ctx.run.id;
      const [w, captures, accounts, observations, extractions, exclusions] = await Promise.all([
        weights(),
        ctx.repos.evidence.listCaptures(runId),
        ctx.repos.evidence.listAccounts(runId),
        ctx.repos.evidence.listObservations(runId),
        ctx.repos.evidence.listExtractionResults(runId),
        ctx.repos.analysis.listExclusions(runId),
      ]);
      const { assessments, notes } = scoreRun(
        {
          runId,
          identifiers: ctx.case.identifiers,
          accounts,
          captures,
          observations,
          extractions,
          sources: (id) => byId.get(id),
          exclusions,
        },
        w,
        { clock: systemClock, newId },
      );
      await ctx.repos.analysis.addLinks(assessments);
      await ctx.progress({ links: assessments.length, scoringNotes: notes.length });
    },
  };
}

/** The stages of a run, in pipeline order (the comparison with the previous run is built in). */
export function defaultStages(options: StageOptions): Stage[] {
  return [createCollectStage(options), createExtractStage(), createScoreStage(options)];
}
