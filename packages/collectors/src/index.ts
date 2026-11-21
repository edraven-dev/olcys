/**
 * @olcys/collectors — OSINT source collectors behind the SourceCollector port plus the pivot planner.
 *
 * Pipeline entry: `loadSourceRegistry()` → `registry.resolveScope(case.scope, mode)` → an egress client over
 * `scope.egressSources` and a robots.txt cache over it → `loadCollectorConfig({ mode })` → `collectCase(...)`.
 * Contracts (types and ports) come from @olcys/core; network I/O only through the injected EgressClient.
 */
export const PACKAGE_NAME = '@olcys/collectors';

export {
  CAPTURE_MANIFEST_SCHEMA,
  artifactKindFor,
  buildCapture,
  captureManifestSha256,
  sha256Hex,
} from './framework/capture.ts';
export {
  CollectorRegistry,
  runCollector,
  type CollectorFactory,
  type CollectorInstance,
} from './framework/collector-registry.ts';
export {
  COLLECTORS_VERSION,
  DEFAULT_FIXTURE_BASE_URL,
  DEFAULT_MANIFEST_PATH,
  createCollectorConfig,
  loadCollectorConfig,
  loadFixtureManifest,
  parseWatchPages,
  type CollectorConfig,
  type CollectorConfigOptions,
  type Env,
  type FixtureManifestInfo,
  type WatchedPage,
} from './framework/config.ts';
export {
  NoFixtureError,
  SourceConfigError,
  SourceRefusedError,
  SyntheticIdentifierError,
  type RefusalReason,
} from './framework/errors.ts';
export {
  SourceCircuitBreaker,
  createSourceHttp,
  findToken,
  identifierTokens,
  type CollectorDeps,
  type RobotsPolicy,
  type SourceHttp,
  type SourceHttpRequest,
} from './framework/http.ts';
export { ResultBuilder, type PageOutcome } from './framework/result.ts';
export {
  DEFAULT_SOURCES_PATH,
  FIXTURE_SOURCE_ID,
  MIN_AMBER_JUSTIFICATION,
  createSourceRegistry,
  loadSourceRegistry,
  parseSourceRegistry,
  type ResolvedScope,
  type ScopeRefusal,
  type SourceRegistry,
} from './framework/source-registry.ts';
export {
  BARRIER_STATUSES,
  NOTE_CODES,
  isBarrierStatus,
  note,
  noteCode,
  rollupOutcomes,
  rollupStatus,
  statusFromHttp,
  type BarrierStatus,
  type CollectorStatus,
  type NoteCode,
} from './framework/status.ts';
export {
  DEFAULT_HOST_PREFIXES,
  isFixtureUrl,
  normaliseHandle,
  recogniseAccountUrl,
  resolveSourceUrl,
  toFixtureUrl,
  toLogicalUrl,
  type FixtureMapping,
  type RecognisedAccount,
} from './framework/urls.ts';
export { detectAccessBarrier, type BarrierInput, type BarrierVerdict } from './html/barrier.ts';
export { blockText, decodeBody, parseHtml } from './html/dom.ts';
export { fetchPage, type PageRequest, type PageResult } from './html/page.ts';
export {
  BITCOINTALK_PARSER_VERSION,
  bitcointalkUrl,
  createBitcointalkCollector,
  findSignedMessages,
  parseBitcointalkPosts,
  parseBitcointalkProfile,
  parseSmfDate,
  selectTopics,
  type BitcointalkPost,
  type BitcointalkProfile,
  type SignedMessageBlock,
} from './platforms/bitcointalk.ts';
export {
  TABLICA_PARSER_VERSION,
  createClassifiedAdsCollector,
  parseClassifiedAd,
  type ClassifiedAd,
} from './platforms/classified-ads.ts';
export {
  GITHUB_PARSER_VERSION,
  createGithubCollector,
  githubLogin,
  parseFundingJson,
  parseGithubProfile,
  parseGithubRepository,
} from './platforms/code-hosting.ts';
export { foldText, matchIdentifiers, type IdentifierMatch } from './platforms/match.ts';
export {
  WYKOP_PARSER_VERSION,
  createWykopCollector,
  parseWykopProfile,
  wykopHandle,
  type SocialProfilePage,
} from './platforms/social-profile.ts';
export {
  TELEGRAM_PARSER_VERSION,
  createTelegramCollector,
  parseTelegramPreview,
  telegramChannel,
  type ChannelPreview,
} from './platforms/telegram.ts';
export {
  collectCase,
  createDefaultCollectorRegistry,
  type CollectCaseOptions,
  type CollectCaseResult,
  type SourceOutcome,
  type TaskRecord,
} from './pivot/collect-case.ts';
export {
  DEFAULT_MAX_TASKS,
  PIVOT_REASONS,
  PIVOT_RULES_VERSION,
  SKIP_REASONS,
  accountAliasKeys,
  planExpansion,
  planInitial,
  taskKey,
  type PivotPlan,
  type PivotProvenance,
  type PivotReason,
  type PlannedTask,
  type PlannerContext,
  type SkipReason,
  type SkippedTask,
} from './pivot/planner.ts';
