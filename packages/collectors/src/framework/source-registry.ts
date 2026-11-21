/**
 * Source register (`config/sources.yaml`) and the case-scope lock: RED sources are never enabled, AMBER sources only
 * with a per-case justification of at least 20 characters, GREEN sources when the case lists them. Offline and replay
 * runs add the fixture site implicitly.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CaseScope, FetchMode, SourceDescriptor, SourceId, SourcesConfig } from '@olcys/core';
import { ContractError, parse, SourcesConfigSchema } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from './capture.ts';
import { REPO_ROOT } from './config.ts';
import { SourceConfigError } from './errors.ts';
import { usesFixtures } from './urls.ts';

export const MIN_AMBER_JUSTIFICATION = 20;
export const FIXTURE_SOURCE_ID = 'fixture_site';
export const DEFAULT_SOURCES_PATH = resolve(REPO_ROOT, 'config', 'sources.yaml');

export type ScopeRefusal = 'red' | 'amber_without_justification' | 'unknown_source';

export interface ResolvedScope {
  readonly mode: FetchMode;
  readonly enabled: readonly SourceDescriptor[];
  readonly refused: readonly { sourceId: SourceId; reason: ScopeRefusal }[];
  readonly amberJustifications: Readonly<Record<SourceId, string>>;
  /**
   * Descriptors for `createEgressClient({ enabledSources })`. Offline and replay every request goes to the fixture
   * site (or its recordings), so each source gets the fixture site's rate limit there.
   */
  readonly egressSources: readonly SourceDescriptor[];
  isEnabled(sourceId: SourceId): boolean;
  refusal(sourceId: SourceId): ScopeRefusal | undefined;
}

export interface SourceRegistry {
  readonly version: string;
  /** SHA-256 of the register file (`RunConfigSnapshot.sourcesConfigSha256`), when loaded from text. */
  readonly configSha256?: string;
  list(): readonly SourceDescriptor[];
  get(id: SourceId): SourceDescriptor | undefined;
  require(id: SourceId): SourceDescriptor;
  resolveScope(scope: Pick<CaseScope, 'enabledSources' | 'amberJustifications'>, mode: FetchMode): ResolvedScope;
}

function validate(descriptors: readonly SourceDescriptor[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of descriptors) {
    const at = `sources.${d.id}`;
    if (seen.has(d.id)) problems.push(`${at}: duplicate id`);
    seen.add(d.id);
    if (!/^[a-z][a-z0-9_]*$/.test(d.id)) problems.push(`${at}: id must match ^[a-z][a-z0-9_]*$`);
    if (d.compliance === 'RED') {
      if (d.enabledByDefault) problems.push(`${at}.enabledByDefault: RED sources are never enabled by default`);
      if (d.rateLimit.requests !== 0) problems.push(`${at}.rateLimit.requests: must be 0 for RED sources`);
      if (d.allowedHosts.length) problems.push(`${at}.allowedHosts: must be empty for RED sources`);
    } else {
      if (d.compliance === 'AMBER' && d.enabledByDefault) {
        problems.push(`${at}.enabledByDefault: AMBER sources are enabled per case only`);
      }
      // Sources that reach the network need a positive rate limit; local datasets (no hosts) never send a request.
      const minRequests = d.allowedHosts.length > 0 ? 1 : 0;
      if (!Number.isInteger(d.rateLimit.requests) || d.rateLimit.requests < minRequests) {
        problems.push(`${at}.rateLimit.requests: must be an integer >= ${minRequests}`);
      }
      if (!(d.rateLimit.perSeconds > 0)) problems.push(`${at}.rateLimit.perSeconds: must be > 0`);
    }
    for (const host of d.allowedHosts) {
      if (!/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)) {
        problems.push(`${at}.allowedHosts: "${host}" must be a lower-case host name without scheme, port or path`);
      }
    }
  }
  return problems;
}

export function createSourceRegistry(
  descriptors: readonly SourceDescriptor[],
  meta: { version?: string; configSha256?: string } = {},
): SourceRegistry {
  const problems = validate(descriptors);
  if (problems.length) throw new SourceConfigError(problems);
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const require = (id: SourceId): SourceDescriptor => {
    const d = byId.get(id);
    if (!d) throw new Error(`unknown source ${id}`);
    return d;
  };
  return {
    version: meta.version ?? 'sources.v1',
    ...(meta.configSha256 ? { configSha256: meta.configSha256 } : {}),
    list: () => [...descriptors],
    get: (id) => byId.get(id),
    require,
    resolveScope(scope, mode) {
      const enabled: SourceDescriptor[] = [];
      const refused: { sourceId: SourceId; reason: ScopeRefusal }[] = [];
      const justifications: Record<SourceId, string> = {};
      for (const id of new Set(scope.enabledSources)) {
        const d = byId.get(id);
        if (!d) refused.push({ sourceId: id, reason: 'unknown_source' });
        else if (d.compliance === 'RED') refused.push({ sourceId: id, reason: 'red' });
        else if (d.compliance === 'AMBER') {
          const justification = scope.amberJustifications[id]?.trim() ?? '';
          if (justification.length >= MIN_AMBER_JUSTIFICATION) {
            enabled.push(d);
            justifications[id] = justification;
          } else refused.push({ sourceId: id, reason: 'amber_without_justification' });
        } else enabled.push(d);
      }
      const fixture = byId.get(FIXTURE_SOURCE_ID);
      if (usesFixtures(mode) && fixture && !enabled.some((d) => d.id === FIXTURE_SOURCE_ID)) enabled.push(fixture);
      const ids = new Set(enabled.map((d) => d.id));
      const egressSources =
        usesFixtures(mode) && fixture ? enabled.map((d) => ({ ...d, rateLimit: { ...fixture.rateLimit } })) : enabled;
      return {
        mode,
        enabled,
        refused,
        amberJustifications: justifications,
        egressSources,
        isEnabled: (id) => ids.has(id),
        refusal: (id) => refused.find((r) => r.sourceId === id)?.reason,
      };
    },
  };
}

/** Parses the register YAML (duplicate keys fail) and validates it against the core schema and the invariants. */
function parseConfig(yamlText: string): SourcesConfig {
  try {
    return parse(SourcesConfigSchema, parseYaml(yamlText, { uniqueKeys: true }));
  } catch (error) {
    if (error instanceof ContractError) {
      throw new SourceConfigError(error.issues.map((i) => `${i.path || '(root)'}: ${i.message}`));
    }
    if (error instanceof Error) throw new SourceConfigError([error.message]);
    throw error;
  }
}

export function parseSourceRegistry(yamlText: string): SourceRegistry {
  const config = parseConfig(yamlText);
  const descriptors: SourceDescriptor[] = [];
  const problems: string[] = [];
  for (const [section, entries] of [
    ['sources', config.sources],
    ['providers', config.providers],
  ] as const) {
    for (const [id, entry] of Object.entries(entries)) {
      if (descriptors.some((d) => d.id === id)) problems.push(`${section}.${id}: id already used`);
      descriptors.push({ id, ...entry } as SourceDescriptor);
    }
  }
  if (problems.length) throw new SourceConfigError(problems);
  return createSourceRegistry(descriptors, { version: config.version, configSha256: sha256Hex(yamlText) });
}

export async function loadSourceRegistry(path: string = DEFAULT_SOURCES_PATH): Promise<SourceRegistry> {
  return parseSourceRegistry(await readFile(path, 'utf8'));
}
