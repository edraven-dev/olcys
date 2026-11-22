/**
 * Mojeek Search API adapter against synthetic responses (hand-written in the shape this adapter documents): JSON
 * format, the key redacted in every log, provenance and recording, plan-dependent storage, `response.status`.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CollectorInput } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCollectorConfig,
  createMojeekSearchCollector,
  mojeekSearchUrl,
  mojeekStoresResults,
  SourceCircuitBreaker,
  type CollectorDeps,
  type SourceRegistry,
} from '../src/index.ts';
import { createTestRun, demoRegistry, identifier, JUSTIFICATION, TEST_REDACTOR } from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'search');
const KEY = 'test-mojeek-key-7a6b5c';

let registry: SourceRegistry;
beforeAll(async () => {
  registry = await demoRegistry();
});

function setup(body: string, status = 200, options: { record?: boolean; cassetteDir?: string } = {}) {
  const sent: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    sent.push(String(input));
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const scope = registry.resolveScope(
    { enabledSources: ['mojeek_search'], amberJustifications: { mojeek_search: JUSTIFICATION } },
    'live',
  );
  const test = createTestRun(scope, 'live', 'run-mojeek', { fetchImpl, ...options });
  const deps: CollectorDeps = {
    mode: 'live',
    config: createCollectorConfig({ mode: 'live', env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  return { sent, test, deps };
}

const input = (kind: 'full_name' | 'email', value: string): CollectorInput => ({
  identifiers: [identifier(kind, value)],
  accounts: [],
  addresses: [],
  depth: 0,
});

describe('Mojeek Search API', () => {
  it('asks for JSON with an exact phrase; language and region bias only for names and nicks', () => {
    const name = new URL(
      mojeekSearchUrl({ text: 'Kacper Fikcyjny', exact: true, maxResults: 20, subject: 'full_name' }, { apiKey: KEY }),
    );
    expect(Object.fromEntries(name.searchParams)).toEqual({
      q: '"Kacper Fikcyjny"',
      fmt: 'json',
      t: '20',
      s: '1',
      api_key: KEY,
      lb: 'PL',
      rb: 'PL',
    });
    const email = new URL(
      mojeekSearchUrl(
        { text: 'kacper.fikcyjny@example.org', exact: true, maxResults: 20, subject: 'email' },
        { apiKey: KEY },
      ),
    );
    expect([email.searchParams.get('lb'), email.searchParams.get('rb')]).toEqual([null, null]);
  });

  it('logs fmt=json and api_key=REDACTED, never the key or the raw answer, and maps the results', async () => {
    const cassetteDir = await mkdtemp(join(tmpdir(), 'olcys-mojeek-'));
    const { sent, test, deps } = setup(await readFile(join(FIXTURES, 'mojeek-ok.json'), 'utf8'), 200, {
      record: true,
      cassetteDir,
    });
    const collector = createMojeekSearchCollector({ apiKey: KEY, plan: 'business' }).create(
      registry.require('mojeek_search'),
      deps,
    );
    const result = await collector.collect(input('full_name', 'Kacper Fikcyjny'), test.ctx);
    expect(sent[0]).toContain(`api_key=${KEY}`);
    expect(test.logs[0]?.urlRedacted).toMatch(/[?&]fmt=json(&|$)/);
    expect(test.logs[0]?.urlRedacted).toMatch(/[?&]api_key=REDACTED(&|$)/);
    expect(test.logs[0]?.containsIdentifier).toBe(true);
    // Hash-only on every plan: the raw answer is neither stored nor recorded.
    await expect(readdir(join(cassetteDir, 'mojeek_search'))).rejects.toThrow(/ENOENT/);
    expect(test.envelopes.map((e) => e.bodyPersisted)).toEqual([false]);
    const stored = [...test.blobs.data.values()].map((bytes) => new TextDecoder().decode(bytes));
    for (const text of [JSON.stringify(test.logs), JSON.stringify(test.envelopes), JSON.stringify(result), ...stored]) {
      expect(text).not.toContain(KEY);
    }
    expect(result.status).toBe('ok');
    expect(result.observations.filter((o) => o.property === 'search.result_url').map((o) => o.value)).toEqual([
      'https://example.org/profil/fikcyjny_kacper',
      'https://example.org/forum/watek/5500002',
    ]);
  });

  it('response.status other than OK → error', async () => {
    const { test, deps } = setup(await readFile(join(FIXTURES, 'mojeek-error.json'), 'utf8'));
    const collector = createMojeekSearchCollector({ apiKey: KEY, plan: 'startup' }).create(
      registry.require('mojeek_search'),
      deps,
    );
    const result = await collector.collect(input('email', 'kacper.fikcyjny@example.org'), test.ctx);
    expect(result.status).toBe('error');
    expect(result.observations).toEqual([]);
    expect(result.notes[0]).toBe('search_provider_error: response status ERROR: invalid API key');
    expect(result.captures[0]?.status).toBe('error');
  });

  it('HTTP 429 → blocked, 401 → error', async () => {
    for (const [status, expected] of [
      [429, 'blocked'],
      [401, 'error'],
    ] as const) {
      const { test, deps } = setup('{}', status);
      const collector = createMojeekSearchCollector({ apiKey: KEY, plan: 'startup' }).create(
        registry.require('mojeek_search'),
        deps,
      );
      // oxlint-disable-next-line no-await-in-loop
      const result = await collector.collect(input('full_name', 'Kacper Fikcyjny'), test.ctx);
      expect([status, result.status]).toEqual([status, expected]);
    }
  });

  it('stores results on Business and Enterprise only', () => {
    expect([
      mojeekStoresResults('startup'),
      mojeekStoresResults('business'),
      mojeekStoresResults('enterprise'),
    ]).toEqual([false, true, true]);
  });
});
