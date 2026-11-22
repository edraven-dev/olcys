import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobRef, BlobStore, EgressLogEntry, ProvenanceEnvelope, SourceDescriptor } from '@olcys/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createEgressClient,
  EgressDeniedError,
  isAllowedByRobots,
  parseRobots,
  ReplayMissError,
  requestHash,
  RobotsCache,
  type EgressClientOptions,
} from '../src/index.ts';

class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.data.set(sha256, bytes);
    return { sha256, bytes: bytes.byteLength, mediaType };
  }
  async get(sha256: string): Promise<Uint8Array> {
    const v = this.data.get(sha256);
    if (!v) throw new Error('missing');
    return v;
  }
  async has(sha256: string): Promise<boolean> {
    return this.data.has(sha256);
  }
}

function source(id: string, overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id,
    name: id,
    kind: 'web',
    compliance: 'GREEN',
    complianceNote: 'test',
    namePl: id,
    complianceNotePl: 'test',
    tosUrl: null,
    enabledByDefault: true,
    requiresApiKey: false,
    sendsIdentifiersExternally: true,
    reliability: 'B',
    rateLimit: { requests: 100, perSeconds: 1 },
    allowedHosts: ['api.example.test'],
    ...overrides,
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const defaultHandler: Handler = (url) => {
  if (url.includes('/redirect-out'))
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } });
  if (url.includes('/redirect-in')) return new Response(null, { status: 302, headers: { location: '/final' } });
  return new Response(JSON.stringify({ ok: true, url }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

function setup(overrides: Partial<EgressClientOptions> = {}, handler: Handler = defaultHandler) {
  const logs: EgressLogEntry[] = [];
  const envelopes: ProvenanceEnvelope[] = [];
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const blobs = new MemoryBlobs();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits.push(init ?? {});
    return handler(url, init ?? {});
  }) as typeof fetch;
  const client = createEgressClient({
    mode: 'live',
    runId: 'run-1',
    enabledSources: [source('api'), source('red', { compliance: 'RED' })],
    blobs,
    sinks: { log: (e) => void logs.push(e), provenance: (p) => void envelopes.push(p) },
    toolVersion: 'test',
    fetchImpl,
    ...overrides,
  });
  return { client, logs, envelopes, calls, inits, blobs };
}

const req = (url: string, sourceId = 'api') => ({ url, sourceId, purpose: 'test', containsIdentifier: true });

describe('egress client', () => {
  it('denies hosts outside the allow-list without sending anything', async () => {
    const { client, logs, calls } = setup();
    await expect(client.fetch(req('https://not-allowed.test/a'))).rejects.toBeInstanceOf(EgressDeniedError);
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ allowed: false, host: 'not-allowed.test', containsIdentifier: true });
  });

  it('denies RED hosts and their subdomains for every request, even when listed as extra or allowed hosts', async () => {
    const { client, calls, logs } = setup({
      enabledSources: [source('api', { allowedHosts: ['api.example.test', 'x.com'] })],
      extraAllowedHosts: ['api.x.com', 'rpc.example.test'],
      redHosts: ['X.com', 'api.x.com.'],
    });
    for (const url of ['https://x.com/a', 'https://api.x.com/a', 'https://cdn.api.x.com/a']) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(client.fetch(req(url))).rejects.toThrow(/RED source/);
    }
    expect(calls).toEqual([]);
    expect(logs.every((l) => !l.allowed)).toBe(true);
    // A host that merely ends with the same text is not a subdomain.
    await expect(client.fetch(req('https://notx.com/a'))).rejects.toThrow(/not in the allow-list/);
    await expect(client.fetch(req('https://rpc.example.test/a'))).resolves.toBeDefined();
  });

  it('treats a *. pattern in the RED hosts as the domain and its subdomains', async () => {
    const { client, calls } = setup({
      redHosts: ['*.red.test'],
      extraAllowedHosts: ['red.test', 'a.red.test', 'ok.test'],
    });
    for (const url of ['https://red.test/a', 'https://a.red.test/a', 'https://b.a.red.test/a']) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(client.fetch(req(url))).rejects.toThrow(/RED source/);
    }
    expect(calls).toEqual([]);
    await expect(client.fetch(req('https://ok.test/a'))).resolves.toBeDefined();
  });

  it('denies a redirect into a RED host', async () => {
    const { client, calls } = setup(
      { redHosts: ['x.com'], extraAllowedHosts: ['x.com'] },
      () => new Response(null, { status: 302, headers: { location: 'https://x.com/profile' } }),
    );
    await expect(client.fetch(req('https://api.example.test/a'))).rejects.toThrow(/RED source/);
    expect(calls).toEqual(['https://api.example.test/a']);
  });

  it('denies RED sources and unknown sources', async () => {
    const { client, calls } = setup();
    await expect(client.fetch(req('https://api.example.test/a', 'red'))).rejects.toThrow(/RED source/);
    await expect(client.fetch(req('https://api.example.test/a', 'nope'))).rejects.toThrow(/not enabled/);
    expect(calls).toEqual([]);
  });

  it('re-checks the allow-list on every redirect hop', async () => {
    const { client, calls } = setup();
    await expect(client.fetch(req('https://api.example.test/redirect-out'))).rejects.toThrow(/redirect/);
    expect(calls).toEqual(['https://api.example.test/redirect-out']);
    const ok = await client.fetch(req('https://api.example.test/redirect-in'));
    expect(ok.finalUrl).toBe('https://api.example.test/final');
    expect(ok.provenance.finalUrl).toBe('https://api.example.test/final');
  });

  it('logs every hop, including redirects', async () => {
    const { client, logs } = setup();
    const res = await client.fetch(req('https://api.example.test/redirect-in'));
    expect(logs.map((l) => [l.urlRedacted, l.httpStatus])).toEqual([
      ['https://api.example.test/redirect-in', 302],
      ['https://api.example.test/final', 200],
    ]);
    expect(res.provenance.egressLogId).toBe(logs[1]?.id);
  });

  it('never follows an external redirect into an internal host', async () => {
    const { client, calls } = setup({}, (url) =>
      url.startsWith('https://')
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4000/api/cases' } })
        : new Response('internal'),
    );
    await expect(client.fetch(req('https://api.example.test/a'))).rejects.toThrow(/internal host/);
    expect(calls).toEqual(['https://api.example.test/a']);
  });

  it('stops after too many redirects', async () => {
    const { client, calls } = setup(
      { maxRedirects: 2 },
      (url) => new Response(null, { status: 302, headers: { location: `${url}x` } }),
    );
    await expect(client.fetch(req('https://api.example.test/a'))).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(3);
  });

  it('drops credentials on cross-origin redirects and switches POST to GET on 303', async () => {
    const { client, inits, calls } = setup(
      { enabledSources: [source('api', { allowedHosts: ['*.example.test'] })] },
      (url) =>
        url.includes('api.')
          ? new Response(null, { status: 303, headers: { location: 'https://cdn.example.test/result' } })
          : new Response('done'),
    );
    await client.fetch({
      ...req('https://api.example.test/search'),
      method: 'POST',
      body: 'q=nick',
      headers: { 'x-api-key': 'SECRET', accept: 'text/html' },
    });
    expect(calls).toEqual(['https://api.example.test/search', 'https://cdn.example.test/result']);
    expect(inits[0]).toMatchObject({ method: 'POST', body: 'q=nick', headers: { 'x-api-key': 'SECRET' } });
    expect(inits[1]?.method).toBe('GET');
    expect(inits[1]?.body).toBeUndefined();
    expect(inits[1]?.headers).toEqual({ 'user-agent': expect.any(String), accept: 'text/html' });
  });

  it('logs transport failures before rethrowing them', async () => {
    const { client, logs } = setup({}, () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    await expect(client.fetch(req('https://api.example.test/a'))).rejects.toThrow('fetch failed');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ allowed: true, error: 'fetch failed: connect ECONNREFUSED' });
  });

  it('refuses bodies above the size cap', async () => {
    const { client, logs, envelopes } = setup({ maxBodyBytes: 10 }, () => new Response('x'.repeat(100)));
    await expect(client.fetch(req('https://api.example.test/a'))).rejects.toThrow(/exceeds 10 bytes/);
    expect(logs[0]).toMatchObject({ httpStatus: 200, error: 'response body exceeds 10 bytes' });
    expect(envelopes).toEqual([]);
  });

  it('redacts secrets in logs and provenance and hashes the stored body', async () => {
    const { client, logs, envelopes, blobs } = setup();
    const res = await client.fetch({ ...req('https://api.example.test/a?apikey=SECRET&q=1'), secretParams: ['q'] });
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    const serialised = JSON.stringify({ logs, envelopes });
    expect(serialised).not.toContain('SECRET');
    expect(envelopes[0]?.url).toContain('apikey=REDACTED');
    const sha = envelopes[0]!.body.sha256;
    expect(
      createHash('sha256')
        .update(await blobs.get(sha))
        .digest('hex'),
    ).toBe(sha);
    expect(envelopes[0]).toMatchObject({ mode: 'live', toolVersion: 'test', bodyPersisted: true, runId: 'run-1' });
  });

  it('throttles per host', async () => {
    const { client } = setup({ enabledSources: [source('api', { rateLimit: { requests: 10, perSeconds: 1 } })] });
    const start = Date.now();
    await Promise.all([1, 2, 3].map((n) => client.fetch(req(`https://api.example.test/${n}`))));
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);
  });

  it('holds the declared rate across all hosts of one source (fake clock)', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { client, calls } = setup({
        enabledSources: [
          source('multi', {
            rateLimit: { requests: 1, perSeconds: 10 },
            allowedHosts: ['a.example.test', 'b.example.test'],
          }),
        ],
      });
      const pending = ['https://a.example.test/1', 'https://b.example.test/2', 'https://a.example.test/3'].map((url) =>
        client.fetch(req(url, 'multi')),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(3);
      await Promise.all(pending);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can hash without storing the body', async () => {
    const { client, envelopes, blobs } = setup();
    await client.fetch({ ...req('https://api.example.test/a'), persistBody: false });
    expect(envelopes[0]?.bodyPersisted).toBe(false);
    expect(blobs.data.size).toBe(0);
  });

  it('serves external hosts from cassettes in offline mode and records in live mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const live = setup({ cassetteDir: dir, record: true });
    await live.client.fetch(req('https://api.example.test/recorded'));
    expect(await readdir(join(dir, 'api'))).toHaveLength(1);

    const offline = setup({ mode: 'offline', cassetteDir: dir });
    const replayed = await offline.client.fetch(req('https://api.example.test/recorded'));
    expect(replayed.json<{ url: string }>().url).toBe('https://api.example.test/recorded');
    expect(offline.calls).toEqual([]);
    await expect(offline.client.fetch(req('https://api.example.test/other'))).rejects.toBeInstanceOf(ReplayMissError);

    const local = await offline.client.fetch(req('http://127.0.0.1:4100/page'));
    expect(local.status).toBe(200);
    expect(offline.calls).toEqual(['http://127.0.0.1:4100/page']);
  });

  it('never reaches an external host live in offline mode, even through a local redirect', async () => {
    const { client, calls } = setup(
      { mode: 'offline' },
      () => new Response(null, { status: 302, headers: { location: 'https://api.example.test/a' } }),
    );
    await expect(client.fetch(req('http://fixture-site:4100/go'))).rejects.toThrow(/external host in offline mode/);
    expect(calls).toEqual(['http://fixture-site:4100/go']);
  });

  it('keeps internal services live in replay mode and replays everything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const { client, calls } = setup({
      mode: 'replay',
      cassetteDir: dir,
      enabledSources: [source('gotenberg', { kind: 'internal_service', allowedHosts: [] }), source('fixture_site')],
    });
    expect((await client.fetch(req('http://gotenberg:3000/health', 'gotenberg'))).status).toBe(200);
    await expect(client.fetch(req('http://127.0.0.1:4100/page', 'fixture_site'))).rejects.toBeInstanceOf(
      ReplayMissError,
    );
    expect(calls).toEqual(['http://gotenberg:3000/health']);
  });

  it('treats a corrupt cassette as an error, not as a miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const url = 'https://api.example.test/broken';
    await mkdir(join(dir, 'api'), { recursive: true });
    await writeFile(join(dir, 'api', `${requestHash('GET', url)}.json`), '{not json');
    const { client } = setup({ mode: 'replay', cassetteDir: dir });
    await expect(client.fetch(req(url))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('marks synthetic cassettes in provenance (replay mode)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const url = 'https://api.example.test/chain';
    await mkdir(join(dir, 'api'), { recursive: true });
    await writeFile(
      join(dir, 'api', `${requestHash('GET', url)}.json`),
      JSON.stringify({
        request: { method: 'GET', url },
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('{}').toString('base64'),
        finalUrl: url,
        synthetic: true,
      }),
    );
    const { client, envelopes } = setup({ mode: 'replay', cassetteDir: dir });
    await client.fetch(req(url));
    expect(envelopes[0]?.synthetic).toBe(true);
  });
});

describe('robots.txt', () => {
  const groups = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public$\n');
  it('applies longest-match rules', () => {
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', '/forum/profile')).toBe(true);
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', '/private/x')).toBe(false);
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', '/private/public')).toBe(true);
    expect(isAllowedByRobots([], 'OLCYS/0.1', '/anything')).toBe(true);
  });
});

describe('egress client — review hardening', () => {
  it('redacts secrets in stored redirect locations but returns them to the caller', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const { client, envelopes } = setup(
      { cassetteDir: dir, record: true },
      () => new Response(null, { status: 302, headers: { location: '/next?token=SECRET&page=2' } }),
    );
    const res = await client.fetch({ ...req('https://api.example.test/start'), redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/next?token=SECRET&page=2');
    expect(envelopes[0]?.responseHeaders['location']).toBe('https://api.example.test/next?token=REDACTED&page=2');
    const [file] = await readdir(join(dir, 'api'));
    expect(await readFile(join(dir, 'api', file!), 'utf8')).not.toContain('SECRET');
  });

  it('does not record hash-only responses as cassettes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const { client } = setup({ cassetteDir: dir, record: true });
    await client.fetch({ ...req('https://api.example.test/terms-restricted'), persistBody: false });
    await expect(readdir(join(dir, 'api'))).rejects.toThrow(/ENOENT/);
  });

  it('denies a local → external → local redirect chain', async () => {
    const { client, calls } = setup({}, (url) =>
      url.startsWith('http://127.0.0.1')
        ? new Response(null, { status: 302, headers: { location: 'https://api.example.test/bounce' } })
        : new Response(null, { status: 302, headers: { location: 'http://gotenberg:3000/forms' } }),
    );
    await expect(client.fetch(req('http://127.0.0.1:4100/start'))).rejects.toThrow(/internal host/);
    expect(calls).toEqual(['http://127.0.0.1:4100/start', 'https://api.example.test/bounce']);
  });

  it('keys cassettes by redirect mode and response-affecting headers', () => {
    const url = 'https://api.example.test/a';
    const plain = requestHash('GET', url);
    expect(requestHash('GET', url, undefined, undefined, {})).toBe(plain);
    expect(requestHash('GET', url, undefined, undefined, { redirect: 'manual' })).not.toBe(plain);
    expect(requestHash('GET', url, undefined, undefined, { 'header:accept': 'application/json' })).not.toBe(plain);
  });

  it('drops body headers when a redirect switches POST to GET', async () => {
    const { client, inits } = setup({}, (url) =>
      url.endsWith('/form') ? new Response(null, { status: 302, headers: { location: '/done' } }) : new Response('ok'),
    );
    await client.fetch({
      ...req('https://api.example.test/form'),
      method: 'POST',
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '3', accept: '*/*' },
    });
    expect(inits[1]?.method).toBe('GET');
    expect(inits[1]?.headers).toEqual({ 'user-agent': expect.any(String), accept: '*/*' });
  });

  it("uses the request's run id for logs and provenance", async () => {
    const { client, logs, envelopes } = setup();
    await client.fetch({ ...req('https://api.example.test/a'), runId: 'run-2' });
    expect(logs[0]?.runId).toBe('run-2');
    expect(envelopes[0]?.runId).toBe('run-2');
  });

  it('logs unreadable cassettes before rethrowing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const url = 'https://api.example.test/broken';
    await mkdir(join(dir, 'api'), { recursive: true });
    await writeFile(join(dir, 'api', `${requestHash('GET', url)}.json`), '{not json');
    const { client, logs } = setup({ mode: 'replay', cassetteDir: dir });
    await expect(client.fetch(req(url))).rejects.toBeInstanceOf(SyntaxError);
    expect(logs[0]?.error).toMatch(/^cassette unreadable/);
  });

  it('marks live responses of a sandbox source in provenance and the egress log', async () => {
    const { client, envelopes, logs } = setup({
      enabledSources: [source('api'), source('box', { sandbox: true, allowedHosts: ['127.0.0.1'] })],
    });
    await client.fetch(req('http://127.0.0.1:8545/', 'box'));
    await client.fetch(req('https://api.example.test/x'));
    expect(envelopes.map((e) => e.sandbox)).toEqual([true, undefined]);
    expect(logs.map((l) => l.sandbox)).toEqual([true, undefined]);
  });

  it('marks fixture-site responses as synthetic', async () => {
    const { client, envelopes } = setup({}, () => new Response('x', { headers: { 'x-olcys-synthetic': 'true' } }));
    await client.fetch(req('http://127.0.0.1:4100/page'));
    expect(envelopes[0]?.synthetic).toBe(true);
  });
});

describe('robots.txt — RFC 9309 details', () => {
  it('matches pathological wildcard rules in linear time', () => {
    const groups = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(40)}b\n`);
    const start = performance.now();
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', `/${'a'.repeat(5000)}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('normalises percent-encoding on both sides', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /zażółć\n');
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', '/%70rivate/x')).toBe(false);
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', new URL('https://h.test/zażółć/1').pathname)).toBe(false);
    expect(isAllowedByRobots(groups, 'OLCYS/0.1', '/public')).toBe(true);
  });

  it('uses the group of our product token instead of *', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: olcys\nDisallow: /private/\n');
    expect(isAllowedByRobots(groups, 'OLCYS/0.1 (OSINT research prototype)', '/forum')).toBe(true);
    expect(isAllowedByRobots(groups, 'OtherBot/1.0', '/forum')).toBe(false);
  });

  it('treats a rate-limited robots.txt (429) as unreachable, not as absent', async () => {
    const { client } = setup({}, (url) =>
      url.endsWith('/robots.txt') ? new Response('', { status: 429 }) : new Response('page'),
    );
    const robots = new RobotsCache(client, 'OLCYS/0.1');
    expect(await robots.check('https://api.example.test/a', 'api')).toEqual({
      allowed: false,
      reason: 'robots.txt rate limited (HTTP 429)',
    });
  });

  it('allows everything on 4xx, disallows on 5xx or errors, and retries after a failure', async () => {
    let now = 0;
    let status = 503;
    const { client } = setup({}, (url) =>
      url.endsWith('/robots.txt') ? new Response('', { status }) : new Response('page'),
    );
    const robots = new RobotsCache(client, 'OLCYS/0.1', { retryAfterFailureMs: 1000, now: () => now });
    expect(await robots.check('https://api.example.test/a', 'api')).toEqual({
      allowed: false,
      reason: 'robots.txt unreachable (HTTP 503)',
    });
    status = 404;
    expect(await robots.isAllowed('https://api.example.test/a', 'api')).toBe(false);
    now = 1001;
    expect(await robots.isAllowed('https://api.example.test/a', 'api')).toBe(true);

    const failing = setup({}, () => {
      throw new TypeError('fetch failed');
    });
    const unreachable = new RobotsCache(failing.client, 'OLCYS/0.1');
    expect(await unreachable.isAllowed('https://api.example.test/a', 'api')).toBe(false);
  });
});

describe('egress client — second review', () => {
  it('redacts credentials embedded in URLs, even for denied requests', async () => {
    const { client, logs } = setup();
    await expect(client.fetch(req('https://user:API_KEY@not-allowed.test/a'))).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    expect(JSON.stringify(logs)).not.toContain('API_KEY');
    expect(logs[0]?.urlRedacted).toBe('https://REDACTED@not-allowed.test/a');
  });

  it('records fixture-site responses so that replay can serve them, but not internal services', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olcys-cassettes-'));
    const sources = [source('fixture_site', { kind: 'fixture' }), source('gotenberg', { kind: 'internal_service' })];
    const live = setup(
      { mode: 'offline', cassetteDir: dir, record: true, enabledSources: sources },
      (url) => new Response(JSON.stringify({ url }), { headers: { 'x-olcys-synthetic': 'true' } }),
    );
    await live.client.fetch(req('http://127.0.0.1:4100/forum/profile', 'fixture_site'));
    await live.client.fetch(req('http://gotenberg:3000/health', 'gotenberg'));
    expect(await readdir(dir)).toEqual(['fixture_site']);

    const replay = setup({ mode: 'replay', cassetteDir: dir, enabledSources: sources });
    const res = await replay.client.fetch(req('http://127.0.0.1:4100/forum/profile', 'fixture_site'));
    expect(res.json<{ url: string }>().url).toBe('http://127.0.0.1:4100/forum/profile');
    expect(res.provenance.synthetic).toBe(true);
    expect(replay.calls).toEqual([]);
  });

  it('refreshes cached robots.txt rules after their lifetime', async () => {
    let now = 0;
    let body = 'User-agent: *\nDisallow:\n';
    const { client } = setup({}, (url) => (url.endsWith('/robots.txt') ? new Response(body) : new Response('page')));
    const robots = new RobotsCache(client, 'OLCYS/0.1', { cacheTtlMs: 1000, now: () => now });
    expect(await robots.isAllowed('https://api.example.test/private/x', 'api')).toBe(true);
    body = 'User-agent: *\nDisallow: /private/\n';
    now = 999;
    expect(await robots.isAllowed('https://api.example.test/private/x', 'api')).toBe(true);
    now = 1000;
    expect(await robots.isAllowed('https://api.example.test/private/x', 'api')).toBe(false);
  });
});
