import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [],
  });
  app = buildApp(runtime);
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

const body = (scope: Record<string, unknown>) => ({
  title: 'Sprawa testowa zakresu',
  purpose: 'Test walidacji zakresu na danych syntetycznych',
  legalBasis: 'demonstracja',
  identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
  scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2, ...scope },
});

const post = (scope: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/cases', payload: body(scope) });

describe('POST /api/cases: source register scope', () => {
  it('refuses a RED source with source_forbidden', async () => {
    const response = await post({ enabledSources: ['x_twitter'] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'source_forbidden',
      details: [{ code: 'source_forbidden', sourceId: 'x_twitter' }],
    });
  });

  it('refuses an unjustified AMBER source with amber_justification_required', async () => {
    const response = await post({ enabledSources: ['bitcointalk'] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'amber_justification_required' });
  });

  it('refuses a short justification with justification_too_short and minLength 20', async () => {
    const response = await post({ enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: 'demo' } });
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error).toBe('justification_too_short');
    expect(json.details[0]).toMatchObject({ sourceId: 'bitcointalk', minLength: 20 });
  });

  it('returns every violation in details, the first one as the code', async () => {
    const response = await post({
      enabledSources: ['nope', 'x_twitter'],
      amberJustifications: { keybase: 'uzasadnienie dla zielonego źródła' },
      maxPivotDepth: 9,
    });
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error).toBe('unknown_source');
    expect(json.details.map((d: { code: string }) => d.code)).toEqual([
      'unknown_source',
      'source_forbidden',
      'orphan_justification',
      'pivot_depth_out_of_range',
    ]);
  });

  it('accepts a justified AMBER source', async () => {
    const response = await post({
      enabledSources: ['bitcointalk'],
      amberJustifications: { bitcointalk: 'Sprawa testowa: strony forum widoczne dla gości' },
    });
    expect(response.statusCode).toBe(201);
  });
});
