import type { EgressClient, EgressResponse } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { findPublishedReport, storeReport } from '../src/index.ts';
import { personaData } from './fixtures.ts';

const answer = (status: number, body: Uint8Array | object, headers: Record<string, string> = {}): EgressResponse => {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    finalUrl: '',
    headers,
    body: bytes,
    text: () => new TextDecoder().decode(bytes),
    json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    provenance: {} as EgressResponse['provenance'],
  };
};

const http = (gotenbergUp: boolean): EgressClient => ({
  async fetch(request) {
    if (request.sourceId === 'gotenberg') {
      if (!gotenbergUp) throw new Error('ECONNREFUSED');
      return request.url.endsWith('/validate')
        ? answer(200, { f: { compliant: true, violations: [] } })
        : answer(200, new TextEncoder().encode('%PDF-1.7 rendered'), { 'gotenberg-remediation-residual': '0' });
    }
    throw new Error('ECONNREFUSED');
  },
});

describe('storeReport with the PDF step', () => {
  it('names the PDF in the version set (bound to the version id)', async () => {
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const data = personaData();
    const stored = await storeReport(
      { repos, blobs },
      data,
      {},
      {
        deps: { http: http(true), blobs, config: { gotenbergUrl: 'http://gotenberg:3000', signing: true } },
      },
    );
    expect(stored.pdf?.status).toBe('unsigned');
    const published = await findPublishedReport({ repos, blobs }, data.run.id);
    expect(published && !published.legacy && published.set.pdf).toMatchObject({
      reportId: data.reportId,
      status: 'unsigned',
      demoCertificate: true,
      warnings: ['signing_unavailable'],
    });
    expect(await blobs.has(published && !published.legacy ? (published.set.pdf?.sha256 ?? '') : '')).toBe(true);
  });

  it('a Gotenberg failure leaves the HTML version without a PDF and reports the code', async () => {
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const data = personaData();
    const stored = await storeReport(
      { repos, blobs },
      data,
      {},
      {
        deps: { http: http(false), blobs, config: { gotenbergUrl: 'http://gotenberg:3000', signing: true } },
      },
    );
    expect(stored.pdfError).toBe('gotenberg_unreachable');
    const published = await findPublishedReport({ repos, blobs }, data.run.id);
    expect(published && !published.legacy && published.set.pdf).toBeUndefined();
  });
});
