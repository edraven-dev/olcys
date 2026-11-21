/**
 * Collector configuration: fixture mapping (offline), collector identity for captures, the synthetic-identifier guard
 * (live) and the watch list of directory pages scanned for case identifiers.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { FetchMode } from '@olcys/core';
import { DEFAULT_HOST_PREFIXES, toLogicalUrl, type FixtureMapping } from './urls.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export const COLLECTORS_VERSION = '0.1.0';
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
export const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, 'fixtures', 'persona', 'manifest.json');
export const DEFAULT_FIXTURE_BASE_URL = 'http://127.0.0.1:4100';

/** A public page that is scanned for the case identifiers (kept only when one of them appears). */
export interface WatchedPage {
  platform: string;
  /** Live URL, or a fixture URL for fixture-only platforms. */
  url: string;
}

export interface CollectorConfig {
  fixture: FixtureMapping;
  /** Analyst or service account recorded on every capture (`OLCYS_COLLECTOR_NAME`). */
  collectorName: string;
  collectorHost?: string;
  /** False unless the deployment verifies the clock against NTP. */
  clockSynced: boolean;
  toolVersion: string;
  /** Persona values that must never reach a real site (live mode guard). */
  syntheticIdentifiers: readonly string[];
  watchList: readonly WatchedPage[];
  bitcointalk: { maxTopicPages: number; resolveByName: boolean; guestTimezoneOffsetMinutes: number };
  github: { maxRepositories: number };
}

/** The parts of `fixtures/persona/manifest.json` the collectors use. */
export interface FixtureManifestInfo {
  hostPrefixes: Record<string, string>;
  syntheticIdentifiers: string[];
  pages: { path: string; platform: string }[];
}

export async function loadFixtureManifest(
  path: string = DEFAULT_MANIFEST_PATH,
): Promise<FixtureManifestInfo | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const raw = JSON.parse(text) as Partial<FixtureManifestInfo>;
  return {
    hostPrefixes: raw.hostPrefixes ?? {},
    syntheticIdentifiers: raw.syntheticIdentifiers ?? [],
    pages: (raw.pages ?? []).map((p) => ({ path: p.path, platform: p.platform })),
  };
}

/** `platform=url` pairs separated by commas or newlines (`OLCYS_WATCH_PAGES`). */
export function parseWatchPages(value: string | undefined): WatchedPage[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const eq = item.indexOf('=');
      if (eq <= 0) return [];
      return [{ platform: item.slice(0, eq).trim(), url: item.slice(eq + 1).trim() }];
    });
}

export interface CollectorConfigOptions {
  mode: FetchMode;
  env?: Env;
  manifest?: FixtureManifestInfo;
  overrides?: Partial<CollectorConfig>;
}

export function createCollectorConfig(options: CollectorConfigOptions): CollectorConfig {
  const env = options.env ?? {};
  const fixture: FixtureMapping = {
    baseUrl: env['OLCYS_FIXTURE_BASE_URL'] || env['FIXTURE_SITE_URL'] || DEFAULT_FIXTURE_BASE_URL,
    hostPrefixes: { ...DEFAULT_HOST_PREFIXES, ...options.manifest?.hostPrefixes },
  };
  const base = fixture.baseUrl.replace(/\/+$/, '');
  // Offline, the persona manifest's page list is the directory (like a sitemap); live it comes from configuration.
  const watchList =
    options.mode === 'offline'
      ? (options.manifest?.pages ?? []).map((p) => ({
          platform: p.platform,
          url: toLogicalUrl(`${base}${p.path}`, fixture),
        }))
      : parseWatchPages(env['OLCYS_WATCH_PAGES']);
  return {
    fixture,
    collectorName: env['OLCYS_COLLECTOR_NAME'] || 'olcys-worker',
    collectorHost: hostname(),
    clockSynced: env['OLCYS_CLOCK_SYNCED'] === '1',
    toolVersion: COLLECTORS_VERSION,
    syntheticIdentifiers: options.manifest?.syntheticIdentifiers ?? [],
    watchList,
    bitcointalk: {
      maxTopicPages: 3,
      // The by-name lookup is verified on the fixture only; live runs need the numeric uid or the profile URL.
      resolveByName: options.mode === 'offline',
      guestTimezoneOffsetMinutes: 0,
    },
    github: { maxRepositories: 5 },
    ...options.overrides,
  };
}

/** Reads the persona manifest (when present) and the environment. */
export async function loadCollectorConfig(options: {
  mode: FetchMode;
  env?: Env;
  manifestPath?: string;
  overrides?: Partial<CollectorConfig>;
}): Promise<CollectorConfig> {
  const manifest = await loadFixtureManifest(options.manifestPath);
  return createCollectorConfig({
    mode: options.mode,
    ...(options.env ? { env: options.env } : {}),
    ...(manifest ? { manifest } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
}
