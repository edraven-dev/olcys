/**
 * Pivot planner (pure, no I/O): input identifiers → collector tasks, and each task's result → follow-up tasks, inside
 * the run's locked scope and depth limit. Every task and every skipped candidate records why it exists.
 *
 * Rules `pivot.v2` (v2 adds E6):
 *   I1  identifier given for platform P            → P's collector
 *   I2  nick / social login                        → same nick on every other platform that has handles
 *   I3  any identifier                             → watch-list pages (kept only when an identifier matches)
 *   I4  identifier that is a profile URL           → that platform's collector
 *   I5  name, nick, e-mail or crypto address       → every web search collector (one query per identifier)
 *   E1  `account.link` to a recognised account     → that platform's collector (depth + 1)
 *   E2  account discovered for the subject         → its handle on the other platforms (depth + 1)
 *   E3  `search.result_url`                        → the page's watch-page collector (same key as I3), else the
 *                                                    recognised account's collector (as E1) (depth + 1)
 *   I6  full name                                  → every registry that looks people up by name (CEIDG)
 *   E4  CEIDG `registry.nip`                       → VAT white list, only when the name search matched exactly one
 *                                                    firm (`registry.ceidg.result_count` = 1); else "ambiguous namesake"
 *   E5  VAT white list `registry.krs`              → KRS (depth + 1)
 *   E6  profile URL of an account the subject gave or their own page linked (input / cross link), and a watch-list page
 *       that matched a case identifier → archive history (Wayback), same depth: a lookup, not a pivot. Pages of third
 *       parties (same-nick probes, search hits, warning channels) are never looked up: the URL is disclosed to the archive.
 *   Third parties found in a registry (representatives, clerks, partners, board members) are never pivots.
 */
import type {
  CollectorInput,
  CollectorResult,
  Id,
  Identifier,
  IdentifierKind,
  Observation,
  OnlineAccount,
  PivotValue,
  SourceId,
} from '@olcys/core';
import type { CollectorFactory, CollectorInstance } from '../framework/collector-registry.ts';
import type { WatchedPage } from '../framework/config.ts';
import type { ResolvedScope } from '../framework/source-registry.ts';
import { isFixtureUrl, recogniseAccountUrl, toLogicalUrl, type FixtureMapping } from '../framework/urls.ts';
import { normalizeKrs, normalizeNip } from '../registries/polish-ids.ts';
import { normaliseQueryText, SEARCH_IDENTIFIER_KINDS } from '../search/query.ts';

export const PIVOT_RULES_VERSION = 'pivot.v2';
export const PIVOT_REASONS = [
  'input_identifier',
  'same_nick',
  'watch_list',
  'linked_url',
  'discovered_account',
  'search_result',
  'registry_identifier',
  'archive_history',
] as const;
export type PivotReason = (typeof PIVOT_REASONS)[number];
export const SKIP_REASONS = [
  'source_red',
  'amber_without_justification',
  'unknown_source',
  'source_not_enabled',
  'not_registered',
  'unsupported',
  'depth_exceeded',
  'duplicate',
  'already_collected',
  'budget_exceeded',
  'ambiguous_namesake',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface PivotProvenance {
  reason: PivotReason;
  rule: string;
  parentTaskKey?: string;
  identifierId?: Id;
  accountId?: Id;
  observationId?: Id;
  captureId?: Id;
  detail?: string;
}

export interface PlannedTask {
  /** `<sourceId>|<subjectKey>`; one task per key and run. */
  key: string;
  sourceId: SourceId;
  platform: string;
  subjectKey: string;
  depth: number;
  input: CollectorInput;
  provenance: PivotProvenance;
}

export interface SkippedTask extends Omit<PlannedTask, 'input'> {
  skip: SkipReason;
}

export interface PivotPlan {
  rulesVersion: string;
  tasks: PlannedTask[];
  skipped: SkippedTask[];
}

export interface PlannerContext {
  scope: ResolvedScope;
  factories: readonly CollectorFactory[];
  /** Collectors of the enabled sources (see `CollectorRegistry.forScope`). */
  collectors: ReadonlyMap<SourceId, CollectorInstance>;
  /** Keys already planned or covered by an account found earlier in the run (aliases). Updated in place. */
  known: Set<string>;
  maxPivotDepth: number;
  maxTasks: number;
  /** Tasks planned so far in the run. Updated in place. */
  counter: { planned: number };
  watchList: readonly WatchedPage[];
  fixture: FixtureMapping;
  /**
   * The case identifiers, given to watch-page collectors of pages found by search (they keep a page only when an
   * identifier appears on it, as for watch-list pages). Default: the identifier the search task looked up.
   */
  identifiers?: readonly Identifier[];
}

export const DEFAULT_MAX_TASKS = 40;
const HANDLE_KINDS: ReadonlySet<IdentifierKind> = new Set(['nickname', 'social_login', 'messenger_id']);
const NICK_KINDS: ReadonlySet<IdentifierKind> = new Set(['nickname', 'social_login']);
const SEARCH_KINDS: ReadonlySet<IdentifierKind> = new Set(SEARCH_IDENTIFIER_KINDS);
/** Platforms whose register entry is RED: links to them are recorded, never followed. */
const RED_PLATFORM_SOURCES: Readonly<Record<string, SourceId>> = {
  x_twitter: 'x_twitter',
  reddit: 'reddit',
  meta: 'meta',
  linkedin: 'linkedin',
  youtube: 'youtube',
  discord: 'discord',
  linktree: 'linktree',
};

const CEIDG_SOURCE = 'ceidg';
const VAT_SOURCE = 'vat_whitelist';
const KRS_SOURCE = 'krs';

export function taskKey(sourceId: SourceId, subjectKey: string): string {
  return `${sourceId}|${subjectKey}`;
}

/**
 * Task subject of a handle on one platform. Account names on the supported platforms are case-insensitive but
 * punctuation is significant (`a-b` and `a_b` are different accounts), so only case and a leading `@` are folded.
 */
export function handleSubject(platform: string, handle: string): string {
  return `handle:${platform}:${handle.normalize('NFKC').trim().replace(/^@+/, '').toLowerCase()}`;
}

/** Keys under which an account found in the run is already covered (by handle and by stable platform id). */
export function accountAliasKeys(
  sourceId: SourceId,
  account: Pick<OnlineAccount, 'platform' | 'handle' | 'platformUserId'>,
): string[] {
  const keys = [taskKey(sourceId, handleSubject(account.platform, account.handle))];
  if (account.platformUserId) keys.push(taskKey(sourceId, `id:${account.platform}:${account.platformUserId}`));
  return keys;
}

const emptyInput = (depth: number): CollectorInput => ({ identifiers: [], accounts: [], addresses: [], depth });

/** Input naming one page (watch list, search result); a collector must support it without any identifier. */
const pageInput = (url: string, depth: number, value: Omit<PivotValue, 'kind' | 'value' | 'method'> = {}) =>
  ({
    ...emptyInput(depth),
    values: [{ kind: 'url', value: url, method: 'search', ...value }],
  }) satisfies CollectorInput;

class Planner {
  readonly #ctx: PlannerContext;
  readonly tasks: PlannedTask[] = [];
  readonly skipped: SkippedTask[] = [];

  constructor(ctx: PlannerContext) {
    this.#ctx = ctx;
  }

  /** `subject`: what the collector must support by itself (default the task input; page tasks: the page alone). */
  consider(task: PlannedTask, subject: CollectorInput = task.input): void {
    const ctx = this.#ctx;
    const skip = (reason: SkipReason): void => {
      const { key, sourceId, platform, subjectKey, depth, provenance } = task;
      this.skipped.push({ key, sourceId, platform, subjectKey, depth, provenance, skip: reason });
    };
    const refusal = ctx.scope.refusal(task.sourceId);
    if (refusal) return skip(refusal === 'red' ? 'source_red' : refusal);
    if (!ctx.scope.isEnabled(task.sourceId)) return skip('source_not_enabled');
    const instance = ctx.collectors.get(task.sourceId);
    if (!instance) return skip('not_registered');
    if (!instance.collector.supports(subject)) return skip('unsupported');
    if (task.depth > ctx.maxPivotDepth) return skip('depth_exceeded');
    const aliases = this.#aliases(task);
    if (ctx.known.has(task.key) || aliases.some((k) => ctx.known.has(k))) return skip('duplicate');
    if (ctx.counter.planned >= ctx.maxTasks) return skip('budget_exceeded');
    ctx.known.add(task.key);
    for (const alias of aliases) ctx.known.add(alias);
    ctx.counter.planned += 1;
    this.tasks.push(task);
  }

  /**
   * Other keys of a page task's subject: a watch-list or search-result page that is an account page of the same
   * platform (e.g. a channel preview) is that account, so a probe or link to it is a duplicate, and vice versa.
   */
  #aliases(task: PlannedTask): string[] {
    if (!task.subjectKey.startsWith('url:')) return [];
    const account = recogniseAccountUrl(task.subjectKey.slice('url:'.length), this.#ctx.fixture);
    if (account?.platform !== task.platform) return [];
    const keys: string[] = [];
    if (account.handle) keys.push(taskKey(task.sourceId, handleSubject(account.platform, account.handle)));
    if (account.platformUserId) keys.push(taskKey(task.sourceId, `id:${account.platform}:${account.platformUserId}`));
    return keys;
  }

  /** Task for a recognised account URL (identifier value or `account.link`). */
  linked(url: string, depth: number, provenance: PivotProvenance, value: Omit<PivotValue, 'kind' | 'value'>): void {
    const account = recogniseAccountUrl(url, this.#ctx.fixture);
    if (!account) return;
    const red = RED_PLATFORM_SOURCES[account.platform];
    const factory = this.#ctx.factories.find((f) => f.platform === account.platform);
    const sourceId = factory?.sourceId ?? red;
    if (!sourceId) return;
    const subjectKey = account.platformUserId
      ? `id:${account.platform}:${account.platformUserId}`
      : handleSubject(account.platform, account.handle ?? account.logicalUrl);
    this.consider({
      key: taskKey(sourceId, subjectKey),
      sourceId,
      platform: account.platform,
      subjectKey,
      depth,
      input: { ...emptyInput(depth), values: [{ kind: 'url', value: account.logicalUrl, ...value }] },
      provenance: { ...provenance, detail: account.logicalUrl },
    });
  }

  /** Same-nick probes of `nick` on every handle platform except `exceptPlatform`. */
  probes(
    nick: string,
    depth: number,
    provenance: PivotProvenance,
    identifiers: Identifier[],
    exceptPlatform?: string,
  ): void {
    for (const factory of this.#ctx.factories) {
      if (!factory.probeHandle || factory.platform === exceptPlatform) continue;
      const handle = factory.probeHandle(nick);
      if (!handle) continue;
      const subjectKey = handleSubject(factory.platform, handle);
      this.consider({
        key: taskKey(factory.sourceId, subjectKey),
        sourceId: factory.sourceId,
        platform: factory.platform,
        subjectKey,
        depth,
        input: {
          ...emptyInput(depth),
          identifiers,
          values: [{ kind: 'username', value: handle, method: 'enumeration' }],
        },
        provenance: { ...provenance, detail: handle },
      });
    }
  }

  /**
   * A page found by web search: the watch-page collector that reads it, under the same key as a watch-list task (so a
   * page reached both ways is collected once), else the collector of the recognised account it shows (as E1). The
   * page alone chooses the collector; the case identifiers only go along, for matching on the page.
   */
  searchResult(
    url: string,
    depth: number,
    provenance: PivotProvenance,
    value: Pick<PivotValue, 'observationId' | 'captureId'>,
    identifiers: readonly Identifier[],
  ): void {
    const logical = toLogicalUrl(url, this.#ctx.fixture);
    const page = pageInput(logical, depth, value);
    for (const factory of this.#ctx.factories) {
      if (!factory.watchesPages || !this.#ctx.collectors.get(factory.sourceId)?.collector.supports(page)) continue;
      const subjectKey = `url:${logical}`;
      this.consider(
        {
          key: taskKey(factory.sourceId, subjectKey),
          sourceId: factory.sourceId,
          platform: factory.platform,
          subjectKey,
          depth,
          input: { ...page, identifiers: [...identifiers] },
          provenance: { ...provenance, detail: logical },
        },
        page,
      );
      return;
    }
    this.linked(logical, depth, provenance, { ...value, method: 'search' });
  }

  /**
   * Registry pivots (E4, E5). A CEIDG search by name matches every namesake: its NIP is followed only when the search
   * found exactly one firm, otherwise the task is recorded as skipped ("ambiguous namesake") and nothing is looked up.
   */
  registries(parent: PlannedTask, result: CollectorResult, depth: number): void {
    const via = (o: Observation) => ({
      reason: 'registry_identifier' as const,
      rule: parent.sourceId === CEIDG_SOURCE ? 'E4' : 'E5',
      parentTaskKey: parent.key,
      observationId: o.id,
      captureId: o.captureId,
    });
    if (parent.sourceId === CEIDG_SOURCE) {
      const count = result.observations.find((o) => o.property === 'registry.ceidg.result_count')?.value;
      const nips = result.observations.filter((o) => o.property === 'registry.nip');
      if (count !== '1' && nips.length) {
        const subjectKey = `ceidg-namesakes:${count ?? 'unknown'}`;
        this.skipped.push({
          key: taskKey(VAT_SOURCE, subjectKey),
          sourceId: VAT_SOURCE,
          platform: VAT_SOURCE,
          subjectKey,
          depth,
          provenance: { ...via(nips[0] as Observation), detail: `${count ?? 'unknown'} firms matched the name` },
          skip: 'ambiguous_namesake',
        });
        return;
      }
      for (const o of nips) {
        const nip = normalizeNip(o.value);
        this.#registryTask(VAT_SOURCE, `nip:${nip}`, { kind: 'nip', value: nip }, depth, via(o), o);
      }
    } else if (parent.sourceId === VAT_SOURCE) {
      for (const o of result.observations.filter((x) => x.property === 'registry.krs')) {
        const krs = normalizeKrs(o.value);
        if (krs) this.#registryTask(KRS_SOURCE, `krs:${krs}`, { kind: 'krs', value: krs }, depth, via(o), o);
      }
    }
  }

  #registryTask(
    sourceId: SourceId,
    subjectKey: string,
    value: Pick<PivotValue, 'kind' | 'value'>,
    depth: number,
    provenance: PivotProvenance,
    from: Observation,
  ): void {
    this.consider({
      key: taskKey(sourceId, subjectKey),
      sourceId,
      platform: sourceId,
      subjectKey,
      depth,
      input: {
        ...emptyInput(depth),
        values: [{ ...value, method: 'search', observationId: from.id, captureId: from.captureId }],
      },
      provenance: { ...provenance, detail: subjectKey },
    });
  }

  /** Archive-history task for one page of the subject (E6); nothing when the case does not enable the archive. */
  history(url: string, depth: number, provenance: PivotProvenance): void {
    const factory = this.#ctx.factories.find((f) => f.archiveHistory);
    if (!factory || !this.#ctx.scope.isEnabled(factory.sourceId)) return;
    const logical = toLogicalUrl(url, this.#ctx.fixture);
    // A page that exists only on the fixture site (no live URL) has no archive to ask: never send it out.
    if (isFixtureUrl(logical, this.#ctx.fixture)) return;
    const subjectKey = `url:${logical}`;
    this.consider({
      key: taskKey(factory.sourceId, subjectKey),
      sourceId: factory.sourceId,
      platform: factory.platform,
      subjectKey,
      depth,
      input: { ...emptyInput(depth), values: [{ kind: 'url', value: logical, method: 'cross_link' }] },
      provenance: { ...provenance, reason: 'archive_history', detail: logical },
    });
  }

  plan(): PivotPlan {
    return { rulesVersion: PIVOT_RULES_VERSION, tasks: this.tasks, skipped: this.skipped };
  }
}

/** Task subject of a web search for an identifier: the address, or the query text in lower case. */
export function searchSubject(identifier: Pick<Identifier, 'kind' | 'value' | 'chain'>): string {
  const text = normaliseQueryText(identifier.value);
  return identifier.kind === 'crypto_address'
    ? `address:${identifier.chain ?? 'unknown'}:${text}`
    : `query:${text.toLowerCase()}`;
}

export function planInitial(identifiers: readonly Identifier[], ctx: PlannerContext): PivotPlan {
  const planner = new Planner(ctx);
  for (const refused of ctx.scope.refused) {
    planner.skipped.push({
      key: taskKey(refused.sourceId, 'scope'),
      sourceId: refused.sourceId,
      platform: '',
      subjectKey: 'scope',
      depth: 0,
      provenance: { reason: 'input_identifier', rule: 'scope' },
      skip: refused.reason === 'red' ? 'source_red' : refused.reason,
    });
  }
  for (const identifier of identifiers) {
    const value = identifier.value.trim();
    const provenance = (reason: PivotReason, rule: string): PivotProvenance => ({
      reason,
      rule,
      identifierId: identifier.id,
    });
    if (/^https?:\/\//i.test(value)) {
      planner.linked(value, 0, provenance('input_identifier', 'I4'), { method: 'input' });
      continue;
    }
    if (identifier.platform && HANDLE_KINDS.has(identifier.kind)) {
      for (const factory of ctx.factories.filter((f) => f.platform === identifier.platform)) {
        const subjectKey = handleSubject(factory.platform, value);
        planner.consider({
          key: taskKey(factory.sourceId, subjectKey),
          sourceId: factory.sourceId,
          platform: factory.platform,
          subjectKey,
          depth: 0,
          input: { ...emptyInput(0), identifiers: [identifier] },
          provenance: provenance('input_identifier', 'I1'),
        });
      }
    }
    if (NICK_KINDS.has(identifier.kind)) {
      planner.probes(value, 0, provenance('same_nick', 'I2'), [identifier], identifier.platform);
    }
    for (const factory of ctx.factories.filter((f) => f.identifierKinds?.includes(identifier.kind))) {
      const subjectKey = `name:${normaliseQueryText(value).toLowerCase()}`;
      planner.consider({
        key: taskKey(factory.sourceId, subjectKey),
        sourceId: factory.sourceId,
        platform: factory.platform,
        subjectKey,
        depth: 0,
        input: { ...emptyInput(0), identifiers: [identifier] },
        provenance: provenance('input_identifier', 'I6'),
      });
    }
  }
  const matchable = identifiers.filter((i) => i.value.trim());
  if (matchable.length) {
    for (const page of ctx.watchList) {
      const factory = ctx.factories.find((f) => f.watchesPages && f.platform === page.platform);
      if (!factory) continue;
      const url = toLogicalUrl(page.url, ctx.fixture);
      const subjectKey = `url:${url}`;
      // The page alone must be readable by the collector; the identifiers go along for matching only.
      const subject = pageInput(url, 0);
      planner.consider(
        {
          key: taskKey(factory.sourceId, subjectKey),
          sourceId: factory.sourceId,
          platform: factory.platform,
          subjectKey,
          depth: 0,
          input: { ...subject, identifiers: matchable },
          provenance: { reason: 'watch_list', rule: 'I3', detail: url },
        },
        subject,
      );
    }
  }
  // Searches last: they never take the task budget from the platform tasks of an identifier.
  const searches = ctx.factories.filter((f) => f.webSearch);
  for (const identifier of matchable) {
    if (!SEARCH_KINDS.has(identifier.kind) || /^https?:\/\//i.test(identifier.value.trim())) continue;
    const subjectKey = searchSubject(identifier);
    for (const factory of searches) {
      planner.consider({
        key: taskKey(factory.sourceId, subjectKey),
        sourceId: factory.sourceId,
        platform: factory.platform,
        subjectKey,
        depth: 0,
        input: { ...emptyInput(0), identifiers: [identifier] },
        provenance: { reason: 'input_identifier', rule: 'I5', identifierId: identifier.id },
      });
    }
  }
  return planner.plan();
}

/** Follow-up tasks from one task's result (one level deeper). */
export function planExpansion(parent: PlannedTask, result: CollectorResult, ctx: PlannerContext): PivotPlan {
  const planner = new Planner(ctx);
  const depth = parent.depth + 1;
  const factory = ctx.factories.find((f) => f.sourceId === parent.sourceId);
  for (const account of result.accounts) {
    const owner = ctx.factories.find((f) => f.platform === account.platform);
    if (owner) for (const key of accountAliasKeys(owner.sourceId, account)) ctx.known.add(key);
  }
  for (const o of result.observations) {
    if (o.property.replace(/\[\d+\]$/, '') !== 'account.link') continue;
    planner.linked(
      o.value,
      depth,
      { reason: 'linked_url', rule: 'E1', parentTaskKey: parent.key, observationId: o.id, captureId: o.captureId },
      { method: 'cross_link', observationId: o.id, captureId: o.captureId },
    );
  }
  for (const o of result.observations) {
    if (o.property !== 'search.result_url') continue;
    planner.searchResult(
      o.value,
      depth,
      { reason: 'search_result', rule: 'E3', parentTaskKey: parent.key, observationId: o.id, captureId: o.captureId },
      { observationId: o.id, captureId: o.captureId },
      ctx.identifiers ?? parent.input.identifiers,
    );
  }
  planner.registries(parent, result, depth);
  if (!factory?.archiveHistory) {
    // E6: the subject's own accounts (given or linked by their own pages), not hypotheses from a same-nick probe.
    for (const account of result.accounts) {
      if (account.discoveredVia.method !== 'input' && account.discoveredVia.method !== 'cross_link') continue;
      if (factory?.pivotOnAccounts === false) continue;
      planner.history(account.profileUrl, parent.depth, {
        reason: 'archive_history',
        rule: 'E6',
        parentTaskKey: parent.key,
        accountId: account.id,
      });
    }
    // E6: a watch-list page is the subject's only when an identifier matched on it (the collector kept observations).
    if (parent.provenance.reason === 'watch_list' && factory?.pivotOnAccounts !== false && result.observations.length) {
      planner.history(parent.subjectKey.replace(/^url:/, ''), parent.depth, {
        reason: 'archive_history',
        rule: 'E6',
        parentTaskKey: parent.key,
      });
    }
  }
  if (factory?.pivotOnAccounts !== false) {
    // An account found by a same-nick probe was looked up with a nick already probed everywhere: no re-probe with
    // its platform spelling (e.g. the code-hosting login `a-b` for the nick `a_b`).
    for (const account of result.accounts.filter((a) => a.discoveredVia.method !== 'enumeration')) {
      planner.probes(
        account.handle,
        depth,
        { reason: 'discovered_account', rule: 'E2', parentTaskKey: parent.key, accountId: account.id },
        [],
        account.platform,
      );
    }
  }
  return planner.plan();
}
