/**
 * The pipeline stages of the MVP: each adapts one package to the pipeline and stores its results through the
 * repository ports. All network access goes through one egress client per run (allow-list, robots.txt, egress log and
 * provenance written to the store); page bodies are redacted before they are stored.
 */
import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type {
  ActivityIndicators,
  AddressRef,
  CashOutEvent,
  ChainId,
  Clock,
  ExclusionDecision,
  FetchMode,
  NormalizedTransfer,
  PriceSource,
  RunContext,
  SourceDescriptor,
  SourceKind,
  UtxoTransaction,
} from '@olcys/core';
import { addressKey, chainFamily, dCmp, dSub, newId, transferKey, uniqueTransfers } from '@olcys/core';
import {
  analyseAddress,
  type AddressAnalysis,
  createAssetRegistry,
  createNbpFxRateSource,
  createSeriesPriceSource,
  createValuator,
  ValuationUnavailableError,
  type Valuator,
  loadCashOutRules,
  loadCashOutScoreConfig,
  loadPriceDataset,
  planCounterpartyExpansion,
  utxoVolumes,
} from '@olcys/analytics';
import {
  createChainProviderRegistry,
  fixtureUrlFor,
  loadChainProviderConfig,
  runChainFetch,
  TipCache,
  withFixtureSite,
} from '@olcys/chain-adapters';
import {
  canonicalAddress,
  DEMO_CURATED_DATASET,
  effectiveOutcome,
  evaluateClusterCollapse,
  evaluateExclusions,
  loadDelegateRegistry,
  loadDenyList,
  loadEntryPoints,
  loadExclusionRules,
  loadLabelDataset,
  loadSafeSingletons,
  MemoryLabelLookup,
  prescreenExclusions,
  toClusterSummary,
} from '@olcys/labels';
import { parse as parseYaml } from 'yaml';
import {
  createSecretRedactor,
  EXTRACTOR_VERSION,
  extractCapture,
  parseDenyList,
  type CaptureContent,
} from '@olcys/address-extractor';
import {
  collectCase,
  createDefaultCollectorRegistry,
  isSearchResultCapture,
  loadCollectorConfig,
  loadSourceRegistry,
  redBlockedHosts,
  type SourceRegistry,
} from '@olcys/collectors';
import {
  createCaptureRecorder,
  createClockSyncCheck,
  custodyCollected,
  readDefaultRouteInterface,
  resolveCollectorIdentity,
} from '@olcys/evidence';
import { createEgressClient, RobotsCache } from '@olcys/http';
import { createReportStage, parseTlp } from '@olcys/reporting';
import { loadWeights, scoreRun } from '@olcys/scoring';
import { classifyFetched } from './address-types.ts';
import { withAnalystOverrides } from './analyst.ts';
import { CLUSTER_EXPANSION, clusterBitcoin } from './clusters.ts';
import { describeGaps, historyGaps, isOwnStatement, transfersOf } from './chain-data.ts';
import { computeFlowGraph, coSpendTransfers, expandFlowHops, flowSettings, type EndpointClass } from './flows.ts';
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
  // One clock check (cached 60 s) and one recorder per process; the collector identity is resolved from local state.
  const maxOffsetMs = Number(env['OLCYS_CLOCK_MAX_OFFSET_MS']);
  const collector = resolveCollectorIdentity({ ...env }, { hostname, networkInterfaces }, readDefaultRouteInterface());
  const recorder = createCaptureRecorder({
    clockSync: createClockSyncCheck({
      clock: systemClock,
      ...(Number.isFinite(maxOffsetMs) && maxOffsetMs > 0 ? { maxOffsetMs } : {}),
    }),
    collector,
    toolVersion: TOOL_VERSION,
    ...(env['OLCYS_GIT_COMMIT'] ? { gitCommit: env['OLCYS_GIT_COMMIT'] } : {}),
  });
  // Platform collectors plus the web search collectors of OLCYS_SEARCH_MODE (keys from the environment only); built
  // once, so a misconfigured search mode stops the start-up instead of failing every run.
  const collectors = createDefaultCollectorRegistry({ mode: options.mode, env });
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
        // The register is the source of truth: RED hosts are denied even when something else would allow them.
        redHosts: redBlockedHosts(sources.list()),
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
          evidence: recorder,
        },
        config,
        robots: new RobotsCache(http, USER_AGENT),
        redactor,
        collectors,
        maxPivotDepth: ctx.case.scope.maxPivotDepth,
        onTask: (event) => ctx.progress({ tasksDone: event.done, tasksPlanned: event.planned }),
      });
      // One transaction: a capture never exists without its `collected` custody event.
      await ctx.repos.evidence.addCaptures(
        result.captures,
        ctx.repos.custody
          ? result.captures.map((c) => ({ id: newId(), ...custodyCollected(c, collector.name) }))
          : undefined,
      );
      await ctx.repos.evidence.addAccounts(result.accounts);
      await ctx.repos.evidence.addObservations(result.observations);
      if (result.partial) {
        const unavailable = result.sources.filter((s) => s.status !== 'ok' && s.status !== 'not_found');
        const ids = unavailable.map((s) => s.sourceId).join(', ');
        ctx.markPartial(
          `unavailable sources: ${ids || 'some pages'}`,
          ids ? { code: 'sources_unavailable', params: { sources: ids } } : { code: 'pages_unavailable' },
        );
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
      // A search result list only points at pages; the pages themselves are collected and extracted, so a snippet
      // never becomes a second copy of an address found on a page.
      const captures = (await ctx.repos.evidence.listCaptures(ctx.evidenceRunId)).filter(
        (c) => c.status === 'ok' && !isSearchResultCapture(c),
      );
      // Redelivery is harmless: a capture already extracted by this run with the current extractor is not stored twice.
      const done = new Set(
        (await ctx.repos.evidence.listExtractionResults(ctx.run.id))
          .filter((r) => r.extractorVersion === EXTRACTOR_VERSION)
          .map((r) => r.captureId),
      );
      // Extract everything first and persist afterwards: a failure (e.g. `SecretLeakError`) stores nothing.
      const results: Awaited<ReturnType<typeof extractCapture>>[] = [];
      const started = Date.now();
      for (const capture of captures.filter((c) => !done.has(c.id))) {
        const artifacts: CaptureContent['artifacts'] = [];
        for (const artifact of capture.artifacts.filter((a) => TEXT_ARTIFACTS.has(a.kind))) {
          // Sequential on purpose: pages are processed one at a time to bound memory.
          // oxlint-disable-next-line no-await-in-loop
          const bytes = await ctx.blobs.get(artifact.blob.sha256);
          artifacts.push({ kind: artifact.kind, mediaType: artifact.blob.mediaType, bytes });
        }
        if (artifacts.length === 0) continue;
        results.push(
          // oxlint-disable-next-line no-await-in-loop
          await extractCapture(
            { captureId: capture.id, url: capture.url, finalUrl: capture.finalUrl, artifacts },
            { denyList: list },
          ),
        );
      }
      let candidates = 0;
      const secretsByKind: Record<string, number> = {};
      let rejected = 0;
      for (const result of results) {
        candidates += result.candidates.length;
        rejected += result.rejected.length;
        for (const s of result.secrets) secretsByKind[s.kind] = (secretsByKind[s.kind] ?? 0) + 1;
      }
      // One all-or-nothing write; a repository without the batch method falls back to one write per capture.
      const evidence = ctx.repos.evidence;
      if (evidence.addExtractions) await evidence.addExtractions(ctx.run.id, results);
      else {
        for (const result of results) {
          // oxlint-disable-next-line no-await-in-loop
          await evidence.addExtraction(ctx.run.id, result);
        }
      }
      // Counts only: nothing extracted from a page (and certainly no secret) goes to the log.
      ctx.logger.info('extraction finished', {
        captures: results.length,
        candidates,
        rejected,
        secrets: secretsByKind,
        ms: Date.now() - started,
      });
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
      const [w, captures, accounts, observations, extractions, exclusions, clusters] = await Promise.all([
        weights(),
        ctx.repos.evidence.listCaptures(ctx.evidenceRunId),
        ctx.repos.evidence.listAccounts(ctx.evidenceRunId),
        ctx.repos.evidence.listObservations(ctx.evidenceRunId),
        ctx.repos.evidence.listExtractionResults(runId),
        ctx.repos.analysis.listExclusions(ctx.evidenceRunId),
        // Co-spend clusters (a heuristic) come with the chain analysis of the evidence run.
        ctx.repos.clusters?.list(ctx.evidenceRunId) ?? Promise.resolve([]),
      ]);
      // A rescore applies the analyst overrides recorded until it was queued; other runs score the evidence as is.
      const { input, applied } = await withAnalystOverrides(
        ctx.repos,
        ctx.run,
        {
          runId,
          identifiers: ctx.case.identifiers,
          accounts,
          captures,
          observations,
          extractions,
          sources: (id) => byId.get(id),
          exclusions,
          clusters,
        },
        ctx.logger,
      );
      const { assessments, notes } = scoreRun(input, w, { clock: systemClock, newId });
      await ctx.repos.analysis.addLinks(assessments);
      await ctx.progress({
        links: assessments.length,
        scoringNotes: notes.length,
        ...(applied ? { analystOverrides: applied } : {}),
      });
    },
  };
}

/** Fetch results that leave a usable (if partial) Bitcoin history to cluster from. */
const CLUSTERABLE: ReadonlySet<string> = new Set(['ok', 'not_found', 'truncated']);

const NBP_BASE_URL = 'https://api.nbp.pl/api';

/** Price source of live runs without a configured price feed: every price is unavailable (never a synthetic one). */
export function noPriceSource(): PriceSource {
  return {
    price: (asset, quote, at) =>
      Promise.reject(
        new ValuationUnavailableError('no_candle', `no price source configured for ${asset}/${quote} at ${at}`),
      ),
  };
}

/** Whether a candidate's chain is selected by the case (an empty selection means all chains). */
export function chainSelected(chain: ChainId, selected: readonly ChainId[]): boolean {
  if (selected.length === 0) return true;
  // An address found without a chain marker is analysed when any EVM chain is selected.
  if (chain === 'evm:unknown') return selected.some((c) => chainFamily(c) === 'evm');
  return selected.includes(chain);
}

/** Identity of a price calculation (what the valuator memoises); equal transfers of different transactions share it. */
const calculationKey = (t: NormalizedTransfer): string =>
  `${t.chain}|${t.asset.contract ?? t.asset.symbol}|${t.amount}|${t.blockTime}`;

/**
 * Records the price calculations the valuator could not complete for lack of a price or an NBP rate (an unknown token
 * is a known limitation, not a failure). `unpricedTransfers` then counts the transfers, by `transferKey`, whose
 * calculation failed: two equal transfers of different transactions are two missing values, not one.
 */
export function trackUnpriced(inner: Valuator): {
  valuator: Valuator;
  unpricedTransfers(transfers: readonly NormalizedTransfer[]): number;
  /** Bitcoin transactions whose net amount (valued per transaction, e.g. a self-send's fee) could not be valued. */
  unpricedNetTxs(address: AddressRef, txs: readonly UtxoTransaction[]): string[];
  /**
   * Distinct failed valuation inputs: the unpriced transfers plus the Bitcoin net amounts of `utxo`, where a net amount
   * that is the very calculation of an unpriced transfer of the same transaction (an incoming payment) counts once.
   */
  unpricedCount(
    transfers: readonly NormalizedTransfer[],
    utxo: readonly { address: AddressRef; txs: readonly UtxoTransaction[] }[],
  ): number;
} {
  const failed = new Set<string>();
  /** Bitcoin net amounts (absolute, per transaction) whose valuation failed. */
  const failedNets = (address: AddressRef, txs: readonly UtxoTransaction[]) =>
    utxoVolumes({ address, transfers: [], decisions: [], utxoTxs: txs })
      .map(({ tx, net }) => ({ tx, amount: dCmp(net, '0') < 0 ? dSub('0', net) : net }))
      .filter(
        ({ tx, amount }) =>
          dCmp(amount, '0') !== 0 && failed.has(`${address.chain}|BTC|${amount}|${tx.blockTime ?? ''}`),
      );
  return {
    valuator: {
      async value(input, ctx) {
        const result = await inner.value(input, ctx);
        if (result.status === 'unpriced' && result.reason !== 'unknown_asset') {
          failed.add(`${input.asset.chain}|${input.asset.contract ?? input.asset.symbol}|${input.amount}|${input.at}`);
        }
        return result;
      },
    },
    unpricedTransfers: (transfers) => uniqueTransfers(transfers).filter((t) => failed.has(calculationKey(t))).length,
    unpricedNetTxs: (address, txs) => failedNets(address, txs).map(({ tx }) => `${tx.chain}|${tx.txid}`),
    unpricedCount: (transfers, utxo) => {
      const failedTransfers = uniqueTransfers(transfers).filter((t) => failed.has(calculationKey(t)));
      // An incoming payment's net amount is the calculation of its transfer: the same failed input.
      const covered = new Set(failedTransfers.map((t) => `${t.chain}|${t.txHash}|${calculationKey(t)}`));
      const nets = new Set<string>();
      for (const { address, txs } of utxo) {
        for (const { tx, amount } of failedNets(address, txs)) {
          const calculation = `${address.chain}|BTC|${amount}|${tx.blockTime ?? ''}`;
          if (!covered.has(`${tx.chain}|${tx.txid}|${calculation}`)) nets.add(`${tx.chain}|${tx.txid}`);
        }
      }
      return failedTransfers.length + nets.size;
    },
  };
}

const read = (path: string): Promise<string> => readFile(join(REPO_ROOT, path), 'utf8');
/** The register entries the chain stage may contact: chain data providers and exchange rates. */
const CHAIN_STAGE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(['chain_data', 'price_fx']);

/**
 * Chain analysis: pre-screen (deny list, labels), chain data through the egress client (fixture site offline),
 * address types (code and probes through the same providers), exclusions A1–A4/A8, one-hop expansion of recipients,
 * activity, cash-out indicators valued in PLN (NBP).
 * Only the providers the case enables receive its addresses (AMBER ones with the analyst's justification).
 * Exchange addresses are never attributed to the person, but their interactions are recorded.
 */
export function createChainStage(options: StageOptions): Stage {
  const env = options.env ?? process.env;
  const sourceRegistry = lazy<SourceRegistry>(() => loadSourceRegistry());
  /** Offline and replay modes run on the synthetic demo world; live runs use real data only. */
  const synthetic = options.mode !== 'live';
  const setup = lazy(async () => {
    const [
      sourcesText,
      providersText,
      labelsText,
      exclusionText,
      denyText,
      cashOutText,
      scoreText,
      pricesText,
      delegatesText,
      entryPointsText,
    ] = await Promise.all([
      read('config/sources.yaml'),
      read('config/chain-providers.yaml'),
      // The synthetic labels and prices must never decide about, or value, real addresses and transactions.
      synthetic ? read('fixtures/labels/demo-curated.json') : Promise.resolve(undefined),
      read('config/rules/exclusion.v1.yaml'),
      read('config/rules/deny-list.v1.yaml'),
      read('config/rules/cashout.v1.yaml'),
      read('config/rules/cashout-score.v1.yaml'),
      synthetic ? read('fixtures/prices/demo-prices.v1.json') : Promise.resolve(undefined),
      read('config/labels/eip7702-delegates.v1.yaml'),
      read('config/labels/erc4337-entrypoints.v1.yaml'),
    ]);
    let providers = loadChainProviderConfig(providersText, parseYaml(sourcesText));
    let nbpBaseUrl: string | undefined;
    const fixture = env['OLCYS_FIXTURE_BASE_URL'] ?? env['FIXTURE_SITE_URL'];
    if (synthetic && fixture) {
      const manifest = JSON.parse(await read('fixtures/persona/manifest.json')) as {
        hostPrefixes: Record<string, string>;
      };
      providers = withFixtureSite(providers, fixture, manifest.hostPrefixes);
      // Synthetic NBP Table A answers come from the fixture site like the chain data (offline, replay).
      nbpBaseUrl = fixtureUrlFor(NBP_BASE_URL, fixture, manifest.hostPrefixes);
    }
    return {
      providers,
      datasetLabels: labelsText
        ? loadLabelDataset(labelsText, DEMO_CURATED_DATASET, { retrievedAt: new Date().toISOString() })
        : [],
      rules: loadExclusionRules(exclusionText),
      denyList: loadDenyList(denyText),
      cashOutRules: loadCashOutRules(cashOutText),
      score: loadCashOutScoreConfig(scoreText),
      // Live: no price source, so every leg that needs a price is "unpriced" (and the run partial).
      prices: pricesText ? createSeriesPriceSource(loadPriceDataset(pricesText)) : noPriceSource(),
      nbpBaseUrl,
      delegates: loadDelegateRegistry(delegatesText),
      entryPoints: loadEntryPoints(entryPointsText),
      safeSingletons: loadSafeSingletons(),
    };
  });

  return {
    step: 'chain.fetch',
    async run(ctx: StageContext) {
      // Chain data is collected evidence: a rescore uses the rescored run's chain analysis and fetches nothing.
      if (ctx.evidenceRunId !== ctx.run.id) {
        await ctx.progress({ chainAnalysisOf: ctx.evidenceRunId });
        return;
      }
      const [c, sources] = await Promise.all([setup(), sourceRegistry()]);
      const runId = ctx.run.id;
      const scope = sources.resolveScope(ctx.case.scope, options.mode);
      const chainSources = scope.enabled.filter((s) => s.kind === 'chain_data').map((s) => s.id);
      const cassetteSet = env['OLCYS_CASSETTE_SET'];
      const http = createEgressClient({
        mode: options.mode,
        runId,
        // Offline and replay every request goes to the fixture site (or its recordings), at the fixture site's pace.
        enabledSources: scope.egressSources.filter((s) => CHAIN_STAGE_KINDS.has(s.kind)),
        redHosts: redBlockedHosts(sources.list()),
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
      // Providers per run: their page memos and circuit breakers belong to one run.
      const providers = createChainProviderRegistry(c.providers, { env: { ...env } });
      const runCtx: RunContext = {
        runId,
        caseId: ctx.case.id,
        mode: options.mode,
        http,
        blobs: ctx.blobs,
        clock: systemClock,
        logger: ctx.logger,
      };
      // The labels used are stored (the report and the API show them); labels already in the store apply too.
      if (c.datasetLabels.length) await ctx.repos.labels.upsert(c.datasetLabels);
      // A live run never lets synthetic labels (e.g. the demo dataset an offline run left in the same store) decide.
      const storedLabels = await ctx.repos.labels.list();
      const labels = new MemoryLabelLookup(
        synthetic
          ? storedLabels
          : storedLabels.filter(
              (l) => l.provenance.synthetic !== true && l.provenance.datasetId !== DEMO_CURATED_DATASET.datasetId,
            ),
      );

      // Candidates found in the evidence and crypto addresses given as case identifiers, in canonical form.
      const found = await ctx.repos.evidence.listCandidates(runId);
      const byKey = new Map<string, AddressRef>();
      const add = (address: AddressRef): void => {
        const canonical = canonicalAddress(address);
        byKey.set(addressKey(canonical), canonical);
      };
      for (const candidate of found) add(candidate.address);
      for (const identifier of ctx.case.identifiers) {
        if (identifier.kind === 'crypto_address' && identifier.chain) {
          add({ chain: identifier.chain, address: identifier.value });
        }
      }
      // The case's chain selection is the analyst's choice: other chains are skipped without making the run partial.
      const everything = [...byKey.values()];
      const candidates = everything.filter((a) => chainSelected(a.chain, ctx.case.scope.chains));
      const skippedByChain = everything.length - candidates.length;
      if (skippedByChain) {
        const skipped = [...new Set(everything.filter((a) => !candidates.includes(a)).map((a) => a.chain))];
        ctx.logger.info('chain stage: candidates outside the selected chains skipped', {
          runId,
          skipped: skippedByChain,
          chains: skipped,
        });
        await ctx.progress({ skippedByChain, skippedChains: skipped });
      }
      const exclusionDeps = { labels, rules: c.rules, denyList: c.denyList, runId, delegates: c.delegates };

      // 1. Pre-screen: deny list and labels decide without chain data.
      const toFetch: AddressRef[] = [];
      for (const candidate of candidates) {
        // Sequential on purpose: a few addresses per case, each a cheap local lookup.
        // oxlint-disable-next-line no-await-in-loop
        const pre = await prescreenExclusions(candidate, exclusionDeps);
        if (effectiveOutcome(pre).outcome !== 'excluded') toFetch.push(candidate);
      }
      const tips = new TipCache();
      // An address of unknown EVM chain is looked up on the EVM chains the case selects (default: Ethereum).
      const selectedEvm = ctx.case.scope.chains.filter(
        (chain) => chainFamily(chain) === 'evm' && chain !== 'evm:unknown',
      );
      const unknownEvmChains = selectedEvm.length ? { unknownEvmChains: selectedEvm } : {};
      const fetched = await runChainFetch(
        toFetch.map((address) => ({ address })),
        providers,
        runCtx,
        { enabledSources: chainSources, tips, ...unknownEvmChains },
      );
      const gaps = historyGaps(fetched.outcomes);
      if (gaps) {
        ctx.markPartial(`chain data incomplete for ${gaps.count} address(es): ${describeGaps(gaps.items)}`, {
          code: 'chain_incomplete',
          params: { count: gaps.count, items: gaps.items },
        });
      }

      // 2. Exclusions with chain data; evm:unknown candidates use the fetch's explicit resolution.
      const resolvedOf = (a: AddressRef): AddressRef => {
        const canonical = canonicalAddress(a);
        return fetched.resolved.find((r) => addressKey(r.requested) === addressKey(canonical))?.resolved ?? canonical;
      };
      // Address types (A2/A3) of the fetched addresses, "as of the recorded chain tip"; stored with the run.
      const assets = createAssetRegistry();
      const types = await classifyFetched(
        toFetch.map(resolvedOf),
        fetched,
        { providers, labels, assets, safeSingletons: c.safeSingletons, entryPoints: c.entryPoints },
        runCtx,
      );
      await ctx.repos.addressTypes?.add(runId, [...types.values()]);
      const unprobed = [...types.values()].filter((t) => t.failedProbe).length;
      if (unprobed) {
        ctx.markPartial(`address type probes failed for ${unprobed} address(es)`, {
          code: 'address_type_probes_failed',
          params: { count: unprobed },
        });
      }
      /** One key per on-chain account: the chain (as fetched for `evm:unknown`) and the canonical address. */
      const targetOf = (a: AddressRef): string => addressKey(resolvedOf(a));
      const published = new Set(
        found.filter((f) => isOwnStatement(f.context.roleCues)).map((f) => targetOf(f.address)),
      );
      const decisions: ExclusionDecision[] = [];
      for (const candidate of candidates) {
        const resolved = resolvedOf(candidate);
        const classification = types.get(addressKey(resolved));
        decisions.push(
          // oxlint-disable-next-line no-await-in-loop
          ...(await evaluateExclusions(
            {
              address: candidate,
              ...(candidate.chain === 'evm:unknown' ? { resolved } : {}),
              ...(classification ? { classification } : {}),
              transfers: transfersOf(resolved, fetched.transfers, fetched.utxoTxs),
              published: published.has(targetOf(candidate)),
            },
            exclusionDeps,
          )),
        );
      }

      // 2b. Bitcoin co-spend clusters of the kept addresses (a heuristic: CoinJoin and service guards, bounded
      // expansion of the co-spend partners). A7 flags a cluster that took in a service, hit the cap or collapsed.
      const clusterSeeds = [
        ...new Set(
          candidates
            .filter((a) => chainFamily(a.chain) === 'bitcoin')
            .filter(
              (a) =>
                effectiveOutcome(decisions.filter((d) => targetOf(d.address) === targetOf(a))).outcome !== 'excluded',
            )
            .filter((a) =>
              fetched.outcomes.some((o) => addressKey(o.address) === addressKey(a) && CLUSTERABLE.has(o.status)),
            )
            .map((a) => a.address),
        ),
      ].toSorted();
      let clusterCount = 0;
      if (clusterSeeds.length) {
        const result = await clusterBitcoin({
          seeds: clusterSeeds,
          txs: fetched.utxoTxs,
          fetched: new Set(toFetch.filter((a) => chainFamily(a.chain) === 'bitcoin').map((a) => a.address)),
          exclusionDeps,
          previousSizes: (await ctx.repos.clusters?.previousSizes(ctx.case.id, clusterSeeds, runId)) ?? new Map(),
          providers,
          runCtx,
          chainSources,
          tips,
          runId,
        });
        const clusterGaps = historyGaps(result.outcomes);
        if (clusterGaps) {
          ctx.markPartial(
            `co-spend partner chain data incomplete for ${clusterGaps.count} address(es): ${describeGaps(clusterGaps.items)}`,
            { code: 'counterparty_chain_incomplete', params: { count: clusterGaps.count, items: clusterGaps.items } },
          );
        }
        if (result.unexpanded > 0) {
          ctx.markPartial(
            `co-spend expansion limited: ${result.unexpanded} partner address(es) not fetched (bound of ${CLUSTER_EXPANSION.maxAddresses} addresses)`,
            { code: 'cluster_expansion_limited', params: { count: result.unexpanded } },
          );
        }
        await ctx.repos.clusters?.add(runId, result.clusters);
        for (const cluster of result.clusters) {
          decisions.push(...evaluateClusterCollapse(toClusterSummary(cluster), { rules: c.rules, runId }));
        }
        clusterCount = result.clusters.length;
      }
      await ctx.repos.analysis.addExclusions(decisions);

      // 3. One-hop expansion of unlabelled recipients (deposit addresses show themselves by their sweeps).
      const kept = candidates.filter(
        (a) => effectiveOutcome(decisions.filter((d) => targetOf(d.address) === targetOf(a))).outcome !== 'excluded',
      );
      const requestedOf = new Map(kept.map((a) => [targetOf(a), a]));
      const analysed = [...new Map(kept.map((a) => [targetOf(a), resolvedOf(a)])).values()];
      const utxoOf = (a: AddressRef) =>
        fetched.utxoTxs.filter(
          (tx) => tx.chain === a.chain && [...tx.inputs, ...tx.outputs].some((io) => io.address === a.address),
        );
      const transfersByKey = new Map(
        analysed.map((a) => [addressKey(a), transfersOf(a, fetched.transfers, fetched.utxoTxs)]),
      );
      const ownTransfers = (a: AddressRef): NormalizedTransfer[] => transfersByKey.get(addressKey(a)) ?? [];
      const analysedKeys = new Set(analysed.map(addressKey));
      const expansion = new Map<string, AddressRef>();
      for (const a of analysed) {
        // oxlint-disable-next-line no-await-in-loop
        const planned = await planCounterpartyExpansion(
          { address: a, transfers: ownTransfers(a), utxoTxs: utxoOf(a) },
          { labels, assets },
          { fetched: analysedKeys },
        );
        for (const counterparty of planned) expansion.set(addressKey(counterparty), counterparty);
      }
      const hop = expansion.size
        ? await runChainFetch(
            // Bitcoin UTXO pages are the listing's own (memoised) requests; they show sweeps spent with other inputs.
            [...expansion.values()].map((address) => ({ address, want: { summary: false, code: false } })),
            providers,
            runCtx,
            { enabledSources: chainSources, tips, ...unknownEvmChains },
          )
        : undefined;
      const hopGaps = hop ? historyGaps(hop.outcomes) : undefined;
      if (hopGaps) {
        ctx.markPartial(
          `counterparty chain data incomplete for ${hopGaps.count} address(es): ${describeGaps(hopGaps.items)}`,
          { code: 'counterparty_chain_incomplete', params: { count: hopGaps.count, items: hopGaps.items } },
        );
      }
      const counterpartyTransfers = new Map(
        [...expansion].map(([key, a]) => [key, transfersOf(a, hop?.transfers ?? [], hop?.utxoTxs ?? [])]),
      );

      // 3b. Fund-flow expansion: counterparties of the analysed addresses (recipients first, then senders), bounded and
      // never past services or excluded addresses; their histories feed the flow graph and the per-order detection.
      const settings = flowSettings(env, c.cashOutRules.maxHops);
      const pool = {
        transfers: [...fetched.transfers, ...(hop?.transfers ?? [])],
        utxoTxs: [...fetched.utxoTxs, ...(hop?.utxoTxs ?? [])],
      };
      const excludedKeys = new Set(
        decisions
          .filter(
            (d) =>
              effectiveOutcome(decisions.filter((x) => targetOf(x.address) === targetOf(d.address))).outcome ===
              'excluded',
          )
          .map((d) => targetOf(d.address)),
      );
      const classes = new Map<string, EndpointClass>();
      const classify = async (address: AddressRef): Promise<EndpointClass> => {
        const canonical = canonicalAddress(address);
        const key = addressKey(canonical);
        const known = classes.get(key);
        if (known) return known;
        const [labelled, pre] = await Promise.all([
          labels.labelsFor(canonical),
          prescreenExclusions(canonical, exclusionDeps),
        ]);
        const cls = {
          service: labelled.length > 0,
          excluded: excludedKeys.has(key) || effectiveOutcome(pre).outcome === 'excluded',
        };
        classes.set(key, cls);
        return cls;
      };
      const fetchedKeys = new Set([
        ...toFetch.map((a) => addressKey(resolvedOf(a))),
        ...analysedKeys,
        ...expansion.keys(),
      ]);
      const txCounts = new Map(fetched.summaries.map((x) => [addressKey(x.address), x.txCount]));
      const counted = trackUnpriced(
        createValuator({
          fx: createNbpFxRateSource({ http, ...(c.nbpBaseUrl ? { baseUrl: c.nbpBaseUrl } : {}) }),
          prices: c.prices,
          assets,
        }),
      );
      const expanded: { address: AddressRef; transfers: NormalizedTransfer[]; hop: number }[] = [];
      const flowExpansion = await expandFlowHops({
        seeds: analysed,
        settings,
        pool,
        fetched: fetchedKeys,
        txCounts,
        assets,
        valuator: counted.valuator,
        ctx: runCtx,
        classify,
        fetch: (plan) =>
          runChainFetch(plan, providers, runCtx, { enabledSources: chainSources, tips, ...unknownEvmChains }),
        async onFetched(address, transfers, hopNumber) {
          expanded.push({ address, transfers, hop: hopNumber });
          counterpartyTransfers.set(addressKey(address), transfers);
        },
      });
      const flowGaps = historyGaps(flowExpansion.outcomes);
      if (flowGaps) {
        ctx.markPartial(
          `fund-flow counterparty chain data incomplete for ${flowGaps.count} address(es): ${describeGaps(flowGaps.items)}`,
          { code: 'counterparty_chain_incomplete', params: { count: flowGaps.count, items: flowGaps.items } },
        );
      }

      // 4. Activity, cash-out indicators and flows, valued in PLN at the NBP rate.
      const deps = {
        labels,
        assets,
        valuator: counted.valuator,
        forwarding: c.rules.a4,
        rules: c.cashOutRules,
        score: c.score,
        runId,
      };
      const indicators: ActivityIndicators[] = [];
      const analyses = new Map<string, AddressAnalysis>();
      // A transfer between two analysed addresses is stored once per run (under the first address analysed).
      const stored = new Set<string>();
      const events: CashOutEvent[] = [];
      for (const a of analysed) {
        const requested = requestedOf.get(addressKey(a));
        // oxlint-disable-next-line no-await-in-loop
        const analysis = await analyseAddress(
          {
            address: a,
            ...(requested?.chain === 'evm:unknown' ? { requested } : {}),
            transfers: ownTransfers(a),
            utxoTxs: utxoOf(a),
            decisions,
            counterpartyTransfers,
            analysed: analysedKeys,
          },
          deps,
          runCtx,
        );
        indicators.push(analysis.indicators);
        events.push(...analysis.events);
        analyses.set(addressKey(a), analysis);
        // oxlint-disable-next-line no-await-in-loop
        await ctx.repos.chain.addTransfers(
          runId,
          a,
          ownTransfers(a).filter((t) => {
            const key = transferKey(t);
            if (stored.has(key)) return false;
            stored.add(key);
            return true;
          }),
        );
      }
      // Counterparty histories (hop expansion) only serve flow queries; analysed addresses keep their own history.
      const counterpartyHistories = [
        ...[...expansion].map(([, a]) => ({
          address: a,
          transfers: transfersOf(a, hop?.transfers ?? [], hop?.utxoTxs ?? []),
          hop: 1,
        })),
        ...expanded,
      ];
      for (const history of counterpartyHistories) {
        // oxlint-disable-next-line no-await-in-loop
        await ctx.repos.chain.addTransfers(
          runId,
          history.address,
          history.transfers.filter((t) => {
            const key = transferKey(t);
            if (stored.has(key)) return false;
            stored.add(key);
            return true;
          }),
          { expansionHop: history.hop },
        );
      }
      // Bitcoin co-spenders: a payment leaves every input address of its transaction, not only the first one.
      const coSpend = coSpendTransfers(pool.transfers, pool.utxoTxs);
      for (const t of coSpend) {
        const key = transferKey(t);
        if (stored.has(key)) continue;
        stored.add(key);
        // oxlint-disable-next-line no-await-in-loop
        await ctx.repos.chain.addTransfers(runId, { chain: t.chain, address: t.from }, [t], { expansionHop: 1 });
      }
      pool.transfers.push(...coSpend);
      // 5. Flow graph: edges valued in PLN, a timeline and a Sankey aggregate per analysed address.
      const graph = await computeFlowGraph({
        runId,
        seeds: analysed,
        settings,
        pool,
        assets,
        valuator: counted.valuator,
        ctx: runCtx,
        classify,
        labelOf: async (a) => (await labels.labelsFor(canonicalAddress(a)))[0],
        swapsOf: (a) => analyses.get(addressKey(a))?.indicators.swaps ?? [],
        eventsOf: (a) => analyses.get(addressKey(a))?.events ?? [],
        ...(ctx.repos.chain.queryFlowEdges ? { query: (id, q) => ctx.repos.chain.queryFlowEdges!(id, q) } : {}),
        computedAt: new Date().toISOString(),
      });
      await ctx.repos.analysis.addFlows?.(runId, graph.edges);
      await ctx.repos.analysis.addFlowViews?.(graph.views);
      if (graph.truncatedQueries > 0) {
        ctx.markPartial(
          `fund-flow graph truncated at ${settings.edgeLimit} edges in ${graph.truncatedQueries} query(ies)`,
          { code: 'flow_graph_truncated', params: { count: graph.truncatedQueries, limit: settings.edgeLimit } },
        );
      }
      // A leg without a price or NBP rate leaves its PLN value missing: say so instead of staying silent.
      // Every distinct failed valuation counts once: a transfer by `transferKey`, a Bitcoin net amount by chain and txid.
      const unpriced = counted.unpricedCount(
        analysed.flatMap(ownTransfers),
        analysed.filter((a) => chainFamily(a.chain) === 'bitcoin').map((a) => ({ address: a, txs: utxoOf(a) })),
      );
      if (unpriced) {
        ctx.markPartial(`PLN valuation unavailable for ${unpriced} transfer(s): no price or NBP rate`, {
          code: 'valuation_unavailable',
          params: { count: unpriced },
        });
      }
      await ctx.repos.analysis.addActivity(runId, indicators);
      await ctx.repos.analysis.addCashOuts(events);
      await ctx.progress({
        chainProviders: chainSources,
        chainAddresses: analysed.length,
        addressTypes: types.size,
        exclusions: decisions.length,
        clusters: clusterCount,
        cashOutEvents: events.length,
        flowEdges: graph.edges.length,
        flowExpandedAddresses: expanded.length,
        unpricedTransfers: unpriced,
      });
    },
  };
}

/** The stages of a run, in pipeline order (the comparison with the previous run is built in). */
export function defaultStages(options: StageOptions): Stage[] {
  const env = options.env ?? process.env;
  const producerName = env['OLCYS_STIX_PRODUCER_NAME']?.trim();
  return [
    createCollectStage(options),
    createExtractStage(),
    createChainStage(options),
    createScoreStage(options),
    // Runs after the built-in comparison with the previous run, so the report includes the changes.
    createReportStage({
      sources: options.sources,
      weightsStatus: 'uncalibrated',
      exports: {
        ...(producerName ? { producerName } : {}),
        tlp: parseTlp(env['OLCYS_EXPORT_TLP']),
      },
    }),
  ];
}
