/**
 * Regression tests: challenge pages and barrier statuses stop a provider for the rest of the run, before any
 * parsing and without retries. Synthetic placeholders only.
 */
import { describe, expect, it } from 'vitest';
import {
  ChainProviderError,
  CircuitBreaker,
  createChainProviderRegistry,
  requestJson,
  runChainFetch,
  type ChainProviderConfig,
  type ChainRequest,
} from '../src/index.ts';
import { FakeEgressClient, testContext, type CannedResponse } from './helpers/fake-egress.ts';

const req: ChainRequest = {
  providerId: 'p',
  sourceId: 'mempool_space',
  url: 'https://esplora.example.test/api/address/x',
  purpose: 'test',
  containsIdentifier: true,
};
const challenge: CannedResponse = {
  status: 200,
  headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
  body: '<html>Just a moment…</html>',
};

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof ChainProviderError ? error.kind : `unexpected: ${String(error)}`;
  }
}

describe('barriers', () => {
  it('treats a challenge page as captcha, even with HTTP 200, and never contacts the provider again', async () => {
    const http = new FakeEgressClient(() => challenge);
    const breaker = new CircuitBreaker();
    const ctx = testContext(http);
    expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe('captcha');
    expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe('captcha');
    expect(http.requests).toHaveLength(1);
  });

  it('stops the provider on 403, 451 and a final 429', async () => {
    for (const [status, kind] of [
      [403, 'blocked'],
      [451, 'blocked'],
      [429, 'rate_limited'],
    ] as const) {
      const http = new FakeEgressClient(() => ({ status, body: 'stop' }));
      const breaker = new CircuitBreaker();
      const ctx = testContext(http);
      // oxlint-disable-next-line no-await-in-loop
      expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe(kind);
      // oxlint-disable-next-line no-await-in-loop
      expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe(kind);
      expect(http.requests).toHaveLength(1);
    }
  });

  it('records a typed outcome for every later address of the run without new requests', async () => {
    const config: ChainProviderConfig = {
      id: 'esplora-test',
      kind: 'esplora',
      sourceId: 'mempool_space',
      baseUrl: 'https://esplora.example.test/api',
      chains: ['bitcoin'],
      priority: 1,
    };
    const http = new FakeEgressClient(() => challenge);
    const result = await runChainFetch(
      [
        { address: { chain: 'bitcoin', address: 'bc1qsynthetica' } },
        { address: { chain: 'bitcoin', address: 'bc1qsyntheticb' } },
      ],
      createChainProviderRegistry([config]),
      testContext(http),
      { enabledSources: ['mempool_space'] },
    );
    expect(result.outcomes.map((o) => o.status)).toEqual(['captcha', 'captcha']);
    expect(http.requests).toHaveLength(1);
  });
});
