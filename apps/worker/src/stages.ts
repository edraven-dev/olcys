/**
 * The pipeline stages of the MVP: each adapts one package to the pipeline and stores its results through the
 * repository ports. All network access goes through one egress client per run (allow-list, robots.txt, egress log and
 * provenance written to the store); page bodies are redacted before they are stored.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActivityIndicators,
  AddressRef,
  CashOutEvent,
  Clock,
  ExclusionDecision,
  FetchMode,
  NormalizedTransfer,
  RunContext,
  SourceDescriptor,
} from '@olcys/core';
import { addressKey, newId, nowIso } from '@olcys/core';
import {
  analyseAddress,
  createAssetRegistry,
  createNbpFxRateSource,
  createSeriesPriceSource,
  createValuator,
  loadCashOutRules,
  loadCashOutScoreConfig,
  loadPriceDataset,
  planCounterpartyExpansion,
} from '@olcys/analytics';
import {
  createChainProviderRegistry,
  loadChainProviderConfig,
  runChainFetch,
  TipCache,
  withFixtureSite,
} from '@olcys/chain-adapters';
import {
  classifyAddressType,
  DEMO_CURATED_DATASET,
  effectiveOutcome,
  evaluateExclusions,
  loadDenyList,
  loadExclusionRules,
  loadLabelDataset,
  MemoryLabelLookup,
  prescreenExclusions,
} from '@olcys/labels';
import { parse as parseYaml } from 'yaml';
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
      // A rescore analyses the rescored run's saved evidence and never fetches anything.
      if (ctx.evidenceRunId !== ctx.run.id) {
        await ctx.progress({ rescoreOf: ctx.evidenceRunId, captures: 0 });
        return;
      }
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
      const captures = (await ctx.repos.evidence.listCaptures(ctx.evidenceRunId)).filter((c) => c.status === 'ok');
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
        ctx.repos.evidence.listCaptures(ctx.evidenceRunId),
        ctx.repos.evidence.listAccounts(ctx.evidenceRunId),
        ctx.repos.evidence.listObservations(ctx.evidenceRunId),
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

const read = (path: string): Promise<string> => readFile(join(REPO_ROOT, path), 'utf8');
const CHAIN_SOURCES = ['mempool_space', 'etherscan_v2', 'trongrid'];
const NBP_SOURCE = 'nbp_api';
/** Cues of a first-person statement: the address was published by its author, not merely mentioned. */
const OWNER_CUES: ReadonlySet<string> = new Set(['first_person_owner', 'exchange_deposit']);

const transfersOf = (a: AddressRef, transfers: readonly NormalizedTransfer[]): NormalizedTransfer[] =>
  transfers.filter((t) => t.chain === a.chain && (t.from === a.address || t.to === a.address));

/**
 * Chain analysis: pre-screen (deny list, labels), chain data through the egress client (fixture site offline),
 * exclusions A1/A2/A4/A8, one-hop expansion of recipients, activity, cash-out indicators valued in PLN (NBP).
 * Exchange addresses are never attributed to the person, but their interactions are recorded.
 */
export function createChainStage(options: StageOptions): Stage {
  const env = options.env ?? process.env;
  const setup = lazy(async () => {
    const [sourcesText, providersText, labelsText, exclusionText, denyText, cashOutText, scoreText, pricesText] =
      await Promise.all([
        read('config/sources.yaml'),
        read('config/chain-providers.yaml'),
        read('fixtures/labels/demo-curated.json'),
        read('config/rules/exclusion.v1.yaml'),
        read('config/rules/deny-list.v1.yaml'),
        read('config/rules/cashout.v1.yaml'),
        read('config/rules/cashout-score.v1.yaml'),
        read('fixtures/prices/demo-prices.v1.json'),
      ]);
    let providers = loadChainProviderConfig(providersText, parseYaml(sourcesText));
    const fixture = env['OLCYS_FIXTURE_BASE_URL'] ?? env['FIXTURE_SITE_URL'];
    if (options.mode !== 'live' && fixture) {
      const manifest = JSON.parse(await read('fixtures/persona/manifest.json')) as {
        hostPrefixes: Record<string, string>;
      };
      providers = withFixtureSite(providers, fixture, manifest.hostPrefixes);
    }
    const rules = loadExclusionRules(exclusionText);
    return {
      registry: createChainProviderRegistry(providers, { env: { ...env } }),
      labels: new MemoryLabelLookup(loadLabelDataset(labelsText, DEMO_CURATED_DATASET, { retrievedAt: nowIso() })),
      rules,
      denyList: loadDenyList(denyText),
      cashOutRules: loadCashOutRules(cashOutText),
      score: loadCashOutScoreConfig(scoreText),
      prices: createSeriesPriceSource(loadPriceDataset(pricesText)),
      // Offline and replay every chain request goes to the fixture site (or its recordings): use its pace, as the
      // collectors do; live runs keep each provider's own rate limit from the register.
      descriptors: options.sources
        .filter((s) => [...CHAIN_SOURCES, NBP_SOURCE].includes(s.id))
        .map((s) => {
          const fixtureSite = options.sources.find((x) => x.id === 'fixture_site');
          return options.mode !== 'live' && fixtureSite && s.id !== NBP_SOURCE
            ? { ...s, rateLimit: fixtureSite.rateLimit }
            : s;
        }),
    };
  });

  return {
    step: 'chain.fetch',
    async run(ctx: StageContext) {
      const c = await setup();
      const runId = ctx.run.id;
      const cassetteSet = env['OLCYS_CASSETTE_SET'];
      const http = createEgressClient({
        mode: options.mode,
        runId,
        enabledSources: c.descriptors,
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
      const runCtx: RunContext = {
        runId,
        caseId: ctx.case.id,
        mode: options.mode,
        http,
        blobs: ctx.blobs,
        clock: systemClock,
        logger: ctx.logger,
      };

      // Candidates found in the evidence and crypto addresses given as case identifiers.
      const found = await ctx.repos.evidence.listCandidates(runId);
      const byKey = new Map<string, AddressRef>();
      for (const candidate of found) byKey.set(addressKey(candidate.address), candidate.address);
      for (const identifier of ctx.case.identifiers) {
        if (identifier.kind === 'crypto_address' && identifier.chain) {
          const address: AddressRef = { chain: identifier.chain, address: identifier.value };
          byKey.set(addressKey(address), address);
        }
      }
      const candidates = [...byKey.values()];
      const published = new Set(
        found.filter((f) => f.context.roleCues.some((cue) => OWNER_CUES.has(cue))).map((f) => f.address.address),
      );
      const exclusionDeps = { labels: c.labels, rules: c.rules, denyList: c.denyList, runId };

      // 1. Pre-screen: deny list and labels decide without chain data.
      const toFetch: AddressRef[] = [];
      for (const candidate of candidates) {
        // Sequential on purpose: a few addresses per case, each a cheap local lookup.
        // oxlint-disable-next-line no-await-in-loop
        const pre = await prescreenExclusions(candidate, exclusionDeps);
        if (effectiveOutcome(pre).outcome !== 'excluded') toFetch.push(candidate);
      }
      const tips = new TipCache();
      const fetched = await runChainFetch(
        toFetch.map((address) => ({ address })),
        c.registry,
        runCtx,
        { enabledSources: CHAIN_SOURCES, tips },
      );
      const unavailable = fetched.outcomes.filter((o) =>
        ['blocked', 'captcha', 'rate_limited', 'error'].includes(o.status),
      );
      if (unavailable.length) ctx.markPartial(`chain data unavailable for ${unavailable.length} address(es)`);

      // 2. Exclusions with chain data; evm:unknown candidates use the fetch's explicit resolution.
      const resolvedOf = (a: AddressRef): AddressRef =>
        fetched.resolved.find((r) => addressKey(r.requested) === addressKey(a))?.resolved ??
        (a.chain.startsWith('evm:') ? { ...a, address: a.address.toLowerCase() } : a);
      const decisions: ExclusionDecision[] = [];
      for (const candidate of candidates) {
        const resolved = resolvedOf(candidate);
        const code = fetched.codes.find((x) => addressKey(x.address) === addressKey(resolved));
        decisions.push(
          // oxlint-disable-next-line no-await-in-loop
          ...(await evaluateExclusions(
            {
              address: candidate,
              ...(candidate.chain === 'evm:unknown' ? { resolved } : {}),
              ...(code ? { classification: classifyAddressType(resolved, code.code, [code.fetchId]) } : {}),
              transfers: transfersOf(resolved, fetched.transfers),
              published: published.has(candidate.address),
            },
            exclusionDeps,
          )),
        );
      }
      await ctx.repos.analysis.addExclusions(decisions);

      // 3. One-hop expansion of unlabelled recipients (deposit addresses show themselves by their sweeps).
      const kept = candidates.filter(
        (a) =>
          effectiveOutcome(decisions.filter((d) => d.address.address.toLowerCase() === a.address.toLowerCase()))
            .outcome !== 'excluded',
      );
      const analysed = kept.map(resolvedOf);
      const requestedOf = new Map(kept.map((a) => [addressKey(resolvedOf(a)), a]));
      const utxoOf = (a: AddressRef) =>
        fetched.utxoTxs.filter((tx) => [...tx.inputs, ...tx.outputs].some((io) => io.address === a.address));
      const assets = createAssetRegistry();
      const fetchedKeys = new Set(analysed.map(addressKey));
      const expansion: AddressRef[] = [];
      for (const a of analysed) {
        expansion.push(
          // oxlint-disable-next-line no-await-in-loop
          ...(await planCounterpartyExpansion(
            { address: a, transfers: transfersOf(a, fetched.transfers), utxoTxs: utxoOf(a) },
            { labels: c.labels, assets },
            { fetched: fetchedKeys },
          )),
        );
      }
      const hop = expansion.length
        ? await runChainFetch(
            expansion.map((address) => ({ address, want: { summary: false, code: false, utxo: false } })),
            c.registry,
            runCtx,
            { enabledSources: CHAIN_SOURCES, tips },
          )
        : undefined;
      const counterpartyTransfers = new Map(
        expansion.map((a) => [addressKey(a), transfersOf(a, hop?.transfers ?? [])]),
      );

      // 4. Activity, cash-out indicators and flows, valued in PLN at the NBP rate.
      const deps = {
        labels: c.labels,
        assets,
        valuator: createValuator({ fx: createNbpFxRateSource({ http }), prices: c.prices, assets }),
        forwarding: c.rules.a4,
        rules: c.cashOutRules,
        score: c.score,
        runId,
      };
      const indicators: ActivityIndicators[] = [];
      const events: CashOutEvent[] = [];
      for (const a of analysed) {
        const requested = requestedOf.get(addressKey(a));
        // oxlint-disable-next-line no-await-in-loop
        const analysis = await analyseAddress(
          {
            address: a,
            ...(requested?.chain === 'evm:unknown' ? { requested } : {}),
            transfers: transfersOf(a, fetched.transfers),
            utxoTxs: utxoOf(a),
            decisions,
            counterpartyTransfers,
            analysed: new Set(analysed.map(addressKey)),
          },
          deps,
          runCtx,
        );
        indicators.push(analysis.indicators);
        events.push(...analysis.events);
        // oxlint-disable-next-line no-await-in-loop
        await ctx.repos.chain.addTransfers(runId, a, transfersOf(a, fetched.transfers));
      }
      await ctx.repos.analysis.addActivity(runId, indicators);
      await ctx.repos.analysis.addCashOuts(events);
      await ctx.progress({
        chainAddresses: analysed.length,
        exclusions: decisions.length,
        cashOutEvents: events.length,
      });
    },
  };
}

/** The stages of a run, in pipeline order (the comparison with the previous run is built in). */
export function defaultStages(options: StageOptions): Stage[] {
  return [createCollectStage(options), createExtractStage(), createChainStage(options), createScoreStage(options)];
}
