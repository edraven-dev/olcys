/**
 * Chain provider configuration (`config/chain-providers.yaml`). Public APIs (demo) and self-hosted nodes
 * (production) differ only in `baseUrl`; the provider's `sourceId` must be registered in `config/sources.yaml`
 * (compliance, hosts, rate limit) and RED providers are refused at load time.
 */
import type { ChainId, ComplianceStatus, SourceId } from '@olcys/core';
import { isChainId } from '@olcys/core';
import { parse as parseYaml } from 'yaml';

export const CHAIN_PROVIDER_KINDS = ['esplora', 'etherscan', 'trongrid', 'otterscan', 'solana_rpc'] as const;
export type ChainProviderKind = (typeof CHAIN_PROVIDER_KINDS)[number];

export interface ChainProviderConfig {
  id: string;
  kind: ChainProviderKind;
  sourceId: SourceId;
  /** e.g. `https://mempool.space/api`, `https://api.etherscan.io/v2/api`, `https://api.trongrid.io`. */
  baseUrl: string;
  /** Environment variable that overrides `baseUrl` when set (e.g. `SANDBOX_EVM_RPC_URL`); `baseUrl` is the default. */
  baseUrlEnv?: string;
  chains: ChainId[];
  /** Lower is tried first. */
  priority: number;
  /** Environment variable holding the API key (sent only when set; redacted in logs and cassettes). */
  apiKeyEnv?: string;
  options?: Record<string, unknown>;
}

/** Runtime dependencies of a provider instance (injected in tests). */
export interface ProviderDeps {
  /** Environment holding API keys (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Back-off sleep for body-level throttling. */
  sleep?: (ms: number) => Promise<void>;
}

/** The API key of a provider, when its environment variable is set and non-empty. */
export function apiKeyOf(config: ChainProviderConfig, deps: ProviderDeps): string | undefined {
  if (!config.apiKeyEnv) return undefined;
  const value = (deps.env ?? process.env)[config.apiKeyEnv];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function fail(message: string): never {
  throw new Error(`chain-providers config: ${message}`);
}

/**
 * Parses `config/chain-providers.yaml`. With `providers` (the `providers:` section of sources.yaml) every
 * `sourceId` must exist there and must not be RED.
 */
export function loadChainProviderConfig(
  yamlText: string,
  register?: { providers: Record<SourceId, { compliance: ComplianceStatus }> },
): ChainProviderConfig[] {
  const doc = parseYaml(yamlText) as { version?: unknown; providers?: unknown };
  if (typeof doc?.version !== 'string') fail('missing version');
  if (!Array.isArray(doc.providers)) fail('providers must be a list');
  const seen = new Set<string>();
  return doc.providers.map((entry: unknown, i: number): ChainProviderConfig => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where = `providers[${i}]`;
    const id = typeof e['id'] === 'string' ? e['id'] : fail(`${where}.id missing`);
    if (seen.has(id)) fail(`${where}.id ${id} is duplicated`);
    seen.add(id);
    const kind = e['kind'];
    if (!CHAIN_PROVIDER_KINDS.includes(kind as ChainProviderKind)) fail(`${where}.kind ${String(kind)} unknown`);
    const sourceId = typeof e['sourceId'] === 'string' ? e['sourceId'] : fail(`${where}.sourceId missing`);
    if (register) {
      const source = register.providers[sourceId];
      if (!source) fail(`${where}.sourceId ${sourceId} is not registered in sources.yaml`);
      if (source.compliance === 'RED') fail(`${where}.sourceId ${sourceId} is RED and may never be contacted`);
    }
    const baseUrl = typeof e['baseUrl'] === 'string' ? e['baseUrl'].replace(/\/+$/, '') : fail(`${where}.baseUrl`);
    if (!/^https?:\/\//.test(baseUrl)) fail(`${where}.baseUrl must be http(s)`);
    const chains = Array.isArray(e['chains']) ? e['chains'] : fail(`${where}.chains must be a list`);
    for (const chain of chains) if (!isChainId(chain)) fail(`${where}.chains: ${String(chain)} is not a chain id`);
    const priority = typeof e['priority'] === 'number' ? e['priority'] : 1;
    const config: ChainProviderConfig = { id, kind: kind as ChainProviderKind, sourceId, baseUrl, chains, priority };
    if (typeof e['baseUrlEnv'] === 'string') config.baseUrlEnv = e['baseUrlEnv'];
    if (typeof e['apiKeyEnv'] === 'string') config.apiKeyEnv = e['apiKeyEnv'];
    if (e['options'] && typeof e['options'] === 'object') config.options = e['options'] as Record<string, unknown>;
    return config;
  });
}

/**
 * Points provider base URLs at the synthetic fixture site (offline/replay demo): `hostPrefixes` maps a real
 * `host/path` prefix to a fixture path, e.g. `mempool.space/api` → `/chain/esplora/api` (see
 * `fixtures/persona/manifest.json`). Unmapped providers keep their base URL. The longest matching prefix wins.
 */
export function withFixtureSite(
  configs: readonly ChainProviderConfig[],
  fixtureBaseUrl: string,
  hostPrefixes: Readonly<Record<string, string>>,
): ChainProviderConfig[] {
  return configs.map((config) => ({ ...config, baseUrl: fixtureUrlFor(config.baseUrl, fixtureBaseUrl, hostPrefixes) }));
}

/** One URL mapped like `withFixtureSite` does for provider base URLs (unmapped URLs are returned unchanged). */
export function fixtureUrlFor(
  baseUrl: string,
  fixtureBaseUrl: string,
  hostPrefixes: Readonly<Record<string, string>>,
): string {
  const fixture = fixtureBaseUrl.replace(/\/+$/, '');
  const url = new URL(baseUrl);
  const target = `${url.host}${url.pathname}`.replace(/\/+$/, '');
  const match = Object.keys(hostPrefixes)
    .filter((prefix) => target === prefix || target.startsWith(`${prefix}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  if (match === undefined) return baseUrl;
  return `${fixture}${hostPrefixes[match]}${target.slice(match.length)}`;
}
