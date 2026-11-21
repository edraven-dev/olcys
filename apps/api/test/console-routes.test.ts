import type { AddressLabel, Logger } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime, type Stage } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Stand-in extraction: one homoglyph match rejected at validation (synthetic value). */
const fakeExtract: Stage = {
  step: 'extract.capture',
  async run(ctx) {
    await ctx.repos.evidence.addExtraction(ctx.run.id, {
      captureId: newId(),
      candidates: [],
      rejected: [
        {
          raw: 'bc1qsyrа8u0s8akk2qyh7kkqcfgrexw85n5aqmnhdv',
          reason: 'homoglyph_detected',
          view: 'visible_text',
          span: { start: 0, end: 42 },
        },
      ],
      secrets: [],
      extractorVersion: 'test',
    });
  },
};

const label: AddressLabel = {
  id: newId(),
  address: { chain: 'evm:1', address: '0x473082f9bd1a611ab783ce9fe814d97b4a8f02b4' },
  entity: 'Giełda Testowa (SYNTHETIC)',
  category: 'exchange',
  attributes: { custodial: true },
  provenance: {
    datasetId: 'demo-curated',
    url: 'http://127.0.0.1:4100/labels.json',
    license: 'CC0-1.0',
    lastmod: nowIso(),
    retrievedAt: nowIso(),
  },
  confidence: 90,
};

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [fakeExtract],
  });
  app = buildApp(runtime);
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('console routes', () => {
  it('lists extraction results with the rejected matches of a run', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: {
        title: 'Persona syntetyczna',
        purpose: 'Test na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper' }],
      },
    });
    const run = await app.inject({ method: 'POST', url: `/api/cases/${created.json().id}/runs`, payload: {} });
    await runtime.idle();
    const items = (await app.inject(`/api/runs/${run.json().id}/extractions`)).json().items;
    expect(items).toEqual([
      expect.objectContaining({ rejected: [expect.objectContaining({ reason: 'homoglyph_detected' })] }),
    ]);
    expect((await app.inject(`/api/runs/${newId()}/extractions`)).statusCode).toBe(404);
  });

  it('lists address labels with their provenance', async () => {
    await runtime.repos.labels.upsert([label]);
    const items = (await app.inject('/api/labels')).json().items;
    expect(items).toEqual([expect.objectContaining({ entity: label.entity, provenance: label.provenance })]);
  });
});
