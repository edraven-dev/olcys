/** Test-only helpers: in-memory stores, a run context over the real egress client and the in-process fixture site. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  BlobRef,
  BlobStore,
  EgressClient,
  EgressLogEntry,
  EgressRequest,
  FetchMode,
  Identifier,
  Logger,
  ProvenanceEnvelope,
  RunContext,
  SecretRedactor,
  SourceDescriptor,
} from '@olcys/core';
import { createEgressClient, RobotsCache } from '@olcys/http';
import { createFixtureServer, type FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import { createCollectorConfig, loadFixtureManifest, type CollectorConfig } from '../src/framework/config.ts';
import { loadSourceRegistry, type ResolvedScope, type SourceRegistry } from '../src/framework/source-registry.ts';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const PUBLIC = resolve(REPO, 'apps', 'fixture-site', 'public');
export const USER_AGENT = 'OLCYS/0.1.0-test (OSINT research prototype; synthetic tests)';

export const BTC_1 = 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2';
export const BTC_2 = 'bc1qgegxcs9wqknj3cnku7p3gqrkl67pmhljyeg6p3';
export const ETH_2 = '0xc3436335B60F0fd74bF6C2638f7a8fA64ac53Cd7';
export const SIGNATURE = 'J624GOcOyQdbXVZySYxKEeDYkKYHP8ZlIa7fF1j4kPbjJb7oho3u999zmjRNXUr+WQCJHePce+z/LLBUwCh6c6c=';

/** Stub of the extractor's redactor: one fake secret format, `TESTSECRET-<alnum>`. */
export const TEST_SECRET = /TESTSECRET-[A-Za-z0-9]+/g;
export const TEST_REDACTOR: SecretRedactor = {
  redact(text) {
    const findings = [...text.matchAll(TEST_SECRET)].map((m) => ({
      kind: 'test_secret',
      start: m.index,
      end: m.index + m[0].length,
    }));
    return { text: text.replace(TEST_SECRET, '[REDACTED:test_secret]'), findings };
  },
};

export async function fixtureFile(relative: string, variant: 'v1' | 'v2' = 'v1'): Promise<string> {
  try {
    return await readFile(resolve(PUBLIC, variant, relative), 'utf8');
  } catch {
    return readFile(resolve(PUBLIC, 'shared', relative), 'utf8');
  }
}

export class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.data.set(sha256, bytes);
    return { sha256, bytes: bytes.byteLength, mediaType };
  }
  async get(sha256: string): Promise<Uint8Array> {
    const bytes = this.data.get(sha256);
    if (!bytes) throw new Error(`missing blob ${sha256}`);
    return bytes;
  }
  async has(sha256: string): Promise<boolean> {
    return this.data.has(sha256);
  }
}

export function memoryLogger(): Logger & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

let counter = 0;
export function identifier(kind: Identifier['kind'], value: string, extra: Partial<Identifier> = {}): Identifier {
  counter += 1;
  return {
    id: `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    caseId: 'case-1',
    kind,
    value,
    isAnchor: false,
    addedAt: '2026-11-21T00:00:00.000Z',
    addedBy: 'test',
    ...extra,
  };
}

export const PERSONA_IDENTIFIERS = (): Identifier[] => [
  identifier('nickname', 'fikcyjny_kacper', { platform: 'bitcointalk', isAnchor: true }),
  identifier('full_name', 'Kacper Fikcyjny'),
  identifier('email', 'kacper.fikcyjny@example.org'),
];

export const JUSTIFICATION = 'Sprawa testowa 2026/1: dane syntetyczne persony';
export const DEMO_SCOPE = {
  enabledSources: ['bitcointalk', 'wykop', 'github', 'telegram_preview'],
  amberJustifications: {
    bitcointalk: JUSTIFICATION,
    wykop: JUSTIFICATION,
    github: JUSTIFICATION,
    telegram_preview: JUSTIFICATION,
  },
};

export interface TestRun {
  ctx: RunContext;
  logs: EgressLogEntry[];
  envelopes: ProvenanceEnvelope[];
  blobs: MemoryBlobs;
  robots: RobotsCache;
  logger: ReturnType<typeof memoryLogger>;
}

/** A run context over the real egress client (offline: the fixture site is live, everything else denied). */
export interface TestRunOptions {
  fetchImpl?: typeof fetch;
  cassetteDir?: string;
  record?: boolean;
  /** Wraps the egress client (e.g. to record what it returned); robots.txt goes through the wrapper too. */
  wrap?: (client: EgressClient) => EgressClient;
}

export function createTestRun(
  scope: ResolvedScope,
  mode: FetchMode = 'offline',
  runId = 'run-1',
  options: TestRunOptions = {},
): TestRun {
  const logs: EgressLogEntry[] = [];
  const envelopes: ProvenanceEnvelope[] = [];
  const blobs = new MemoryBlobs();
  // Tests need no politeness delays towards the local fixture server.
  const enabledSources: SourceDescriptor[] = scope.egressSources.map((d) => ({
    ...d,
    rateLimit: { requests: 1000, perSeconds: 1 },
  }));
  const client = createEgressClient({
    mode,
    runId,
    enabledSources,
    blobs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.cassetteDir ? { cassetteDir: options.cassetteDir } : {}),
    ...(options.record ? { record: true } : {}),
    sinks: { log: (e) => void logs.push(e), provenance: (p) => void envelopes.push(p) },
    toolVersion: '0.1.0-test',
    userAgent: USER_AGENT,
  });
  const http = options.wrap ? options.wrap(client) : client;
  const logger = memoryLogger();
  const ctx: RunContext = {
    runId,
    caseId: 'case-1',
    mode,
    http,
    blobs,
    clock: { now: () => new Date() },
    logger,
  };
  return { ctx, logs, envelopes, blobs, robots: new RobotsCache(http, USER_AGENT), logger };
}

export async function startFixture(variant: 'v1' | 'v2' = 'v1'): Promise<FixtureServer> {
  return createFixtureServer({ root: PUBLIC, variant, host: '127.0.0.1', port: 0, allowVariantSwitch: false });
}

export async function testConfig(server: FixtureServer, mode: FetchMode = 'offline'): Promise<CollectorConfig> {
  const manifest = await loadFixtureManifest();
  return createCollectorConfig({
    mode,
    env: { OLCYS_FIXTURE_BASE_URL: server.url, OLCYS_COLLECTOR_NAME: 'test-analyst' },
    ...(manifest ? { manifest } : {}),
  });
}

export async function demoRegistry(): Promise<SourceRegistry> {
  return loadSourceRegistry();
}

/** An egress client that records requests and answers from a handler (no network). */
export function fakeEgress(
  handler: (request: EgressRequest) => { status: number; body?: string; headers?: Record<string, string> } = () => ({
    status: 200,
    body: '<html><body>ok</body></html>',
  }),
): EgressClient & { requests: EgressRequest[] } {
  const requests: EgressRequest[] = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      const answer = handler(request);
      const body = new TextEncoder().encode(answer.body ?? '');
      const headers = { 'content-type': 'text/html; charset=utf-8', ...answer.headers };
      return {
        status: answer.status,
        finalUrl: request.url,
        headers,
        body,
        text: () => answer.body ?? '',
        json: <T>() => JSON.parse(answer.body ?? 'null') as T,
        provenance: {
          fetchId: `fetch-${requests.length}`,
          sourceId: request.sourceId,
          provider: 'fake',
          method: 'GET',
          url: request.url,
          requestedAt: '2026-11-21T10:00:00.000Z',
          receivedAt: '2026-11-21T10:00:01.000Z',
          httpStatus: answer.status,
          responseHeaders: headers,
          body: {
            sha256: createHash('sha256').update(body).digest('hex'),
            bytes: body.byteLength,
            mediaType: headers['content-type'],
          },
          mode: 'live',
          toolVersion: 'test',
          userAgent: USER_AGENT,
          egressLogId: `log-${requests.length}`,
        },
      };
    },
  };
}
