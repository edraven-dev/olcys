import { describe, expect, it } from 'vitest';
import {
  baseUnitsToDecimal,
  ChainProviderError,
  CircuitBreaker,
  classifyEtherscan,
  decodeCursor,
  encodeCursor,
  parseJsonExact,
  requestJson,
  type ChainRequest,
} from '../src/index.ts';
import { FakeEgressClient, testContext, type CannedResponse } from './helpers/fake-egress.ts';

const req: ChainRequest = {
  providerId: 'p',
  sourceId: 'etherscan_v2',
  url: 'https://api.example.test/api?module=account&apikey=SECRET',
  purpose: 'test',
  containsIdentifier: true,
  secretParams: ['apikey'],
};

function sequence(...responses: CannedResponse[]): FakeEgressClient {
  let i = 0;
  return new FakeEgressClient(() => responses[Math.min(i++, responses.length - 1)] ?? { status: 500, body: '' });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof ChainProviderError ? error.kind : `unexpected: ${String(error)}`;
  }
}

describe('base units and cursors', () => {
  it('converts integer base units without floats', () => {
    expect(baseUnitsToDecimal('123456789', 8)).toBe('1.23456789');
    expect(baseUnitsToDecimal('5000000', 8)).toBe('0.05');
    expect(baseUnitsToDecimal('0', 18)).toBe('0');
    expect(baseUnitsToDecimal('1000000000000000000', 18)).toBe('1');
    expect(baseUnitsToDecimal('1', 18)).toBe('0.000000000000000001');
    expect(baseUnitsToDecimal(14_980_000, 8)).toBe('0.1498');
    for (const bad of ['-1', '1.5', '', 'abc']) expect(() => baseUnitsToDecimal(bad, 8)).toThrow(TypeError);
  });

  it('round-trips cursors and refuses another provider’s cursor', () => {
    const cursor = encodeCursor('a', { page: 2 });
    expect(decodeCursor<{ page: number }>('a', cursor).page).toBe(2);
    expect(() => decodeCursor('b', cursor)).toThrow(/another provider/);
  });

  it('keeps big integers and decimals exact when parsing JSON', () => {
    expect(parseJsonExact('{"a":123456789012345678901,"b":3.6500,"c":7}')).toEqual({
      a: '123456789012345678901',
      b: '3.6500',
      c: 7,
    });
  });
});

describe('requestJson', () => {
  const throttled = { body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } };
  const ok = { body: { status: '1', message: 'OK', result: '42' } };

  it('retries body-level throttling with back-off, as new logged requests', async () => {
    const http = sequence(throttled, ok);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const result = await requestJson<{ result: string }>(testContext(http), req, {
      classify: classifyEtherscan,
      sleep,
    });
    expect(result.data.result).toBe('42');
    expect(http.requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(800);
    expect(sleeps[0]).toBeLessThanOrEqual(1200);
    expect(http.requests[0]).toMatchObject({ containsIdentifier: true, secretParams: ['apikey'] });
  });

  it('gives up after three retries of throttling', async () => {
    const http = sequence(throttled);
    const kind = await kindOf(
      requestJson(testContext(http), req, { classify: classifyEtherscan, sleep: () => Promise.resolve() }),
    );
    expect(kind).toBe('rate_limited');
    expect(http.requests).toHaveLength(4);
  });

  it('never retries HTTP 429 itself (the egress client owns that)', async () => {
    const http = sequence({ status: 429, body: 'slow down' });
    expect(await kindOf(requestJson(testContext(http), req))).toBe('rate_limited');
    expect(http.requests).toHaveLength(1);
  });

  it('stops a provider for the rest of the run after a 403', async () => {
    const http = sequence({ status: 403, body: 'forbidden' }, ok);
    const breaker = new CircuitBreaker();
    const ctx = testContext(http);
    expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe('blocked');
    expect(await kindOf(requestJson(ctx, req, { breaker }))).toBe('blocked');
    expect(http.requests).toHaveLength(1);
    // another run is not affected
    expect(await kindOf(requestJson(testContext(http), req, { breaker }))).toBe('ok');
  });

  it('maps egress denials, replay misses and garbage bodies', async () => {
    const denied = new FakeEgressClient(() => {
      const error = new Error('egress denied to x');
      error.name = 'EgressDeniedError';
      throw error;
    });
    expect(await kindOf(requestJson(testContext(denied), req))).toBe('egress_denied');
    const miss = new FakeEgressClient(() => {
      const error = new Error('no recorded response');
      error.name = 'ReplayMissError';
      throw error;
    });
    expect(await kindOf(requestJson(testContext(miss), req))).toBe('replay_miss');
    expect(await kindOf(requestJson(testContext(sequence({ body: '<html>' })), req))).toBe('invalid_response');
    expect(await kindOf(requestJson(testContext(sequence({ status: 404, body: '' })), req))).toBe('not_found');
    expect(await kindOf(requestJson(testContext(sequence({ status: 400, body: '' })), req))).toBe('invalid_request');
  });
});
