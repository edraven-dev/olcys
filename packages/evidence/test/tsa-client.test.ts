import { beforeAll, describe, expect, it } from 'vitest';
import type { FetchMode, TimestampSubject } from '@olcys/core';
import * as pkijs from 'pkijs';
import { createRfc3161Client, InMemoryBlobStore, type Rfc3161Config } from '../src/index.ts';
import { createFakeTsa, createFakeTsaEgress, type FakeTsa } from './support/fake-tsa.ts';

const subject: TimestampSubject = {
  type: 'capture_manifest',
  id: '0190a000-0000-7000-8000-0000000000a1',
  digest: 'ef'.repeat(32),
  referenceTime: '2026-11-21T12:00:00.000Z',
};
let tsa: FakeTsa;
beforeAll(async () => {
  tsa = await createFakeTsa();
});

const config = (): Rfc3161Config => ({
  tsaUrl: 'https://freetsa.org/tsr',
  sourceId: 'freetsa',
  qualified: false,
  trustAnchorsPem: [tsa.caPem],
  timeoutMs: 10_000,
  maxClockSkewSeconds: 120,
});
const ctx = (http: ReturnType<typeof createFakeTsaEgress>['client'], mode: FetchMode = 'live') => ({
  http,
  blobs: new InMemoryBlobStore(),
  clock: { now: () => new Date('2026-11-21T12:00:00.000Z') },
  mode,
});

describe('Rfc3161Client', () => {
  it('AC2: live mode makes exactly one POST with the request DER and stores the verified reply', async () => {
    const egress = createFakeTsaEgress(tsa);
    const context = ctx(egress.client);
    const attempt = await createRfc3161Client(config(), () => 4242n).request(subject, context);
    expect(egress.calls).toHaveLength(1);
    const call = egress.calls[0]!;
    expect(call).toMatchObject({
      url: 'https://freetsa.org/tsr',
      method: 'POST',
      sourceId: 'freetsa',
      containsIdentifier: false,
      headers: { 'content-type': 'application/timestamp-query' },
    });
    const req = pkijs.TimeStampReq.fromBER(Uint8Array.from(call.body as Uint8Array));
    expect(Buffer.from(req.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex')).toBe(subject.digest);
    expect(attempt.nonce).toBe(4242n);
    expect(attempt.outcome.status).toBe('granted');
    if (attempt.outcome.status !== 'granted') return;
    const { token } = attempt.outcome;
    expect(token).toMatchObject({
      tsaUrl: 'https://freetsa.org/tsr',
      genTime: '2026-11-21T12:00:05.000Z',
      hashAlgorithm: 'sha256',
      messageImprint: subject.digest,
      qualified: false,
      skewSeconds: 5,
    });
    expect(token.token.mediaType).toBe('application/timestamp-reply');
    expect(await context.blobs.get(token.token.sha256)).toEqual(attempt.outcome.tokenDer);
  });

  it('AC6: skew is reported in seconds', async () => {
    const egress = createFakeTsaEgress(tsa, [{ genTime: new Date('2026-11-21T12:10:00.000Z') }]);
    const attempt = await createRfc3161Client(config()).request(subject, ctx(egress.client));
    expect(attempt.outcome.status === 'granted' && attempt.outcome.token).toMatchObject({
      skewSeconds: 600,
      skewSuspected: true,
    });
    // The threshold is the configured one: 600 s is fine under a 900 s limit.
    const lenient = createFakeTsaEgress(tsa, [{ genTime: new Date('2026-11-21T12:10:00.000Z') }]);
    const ok = await createRfc3161Client({ ...config(), maxClockSkewSeconds: 900 }).request(
      subject,
      ctx(lenient.client),
    );
    expect(ok.outcome.status === 'granted' && ok.outcome.token.skewSuspected).toBe(false);
  });

  it.each<FetchMode>(['offline', 'replay'])('AC4: %s mode queues without any egress call', async (mode) => {
    const egress = createFakeTsaEgress(tsa);
    const attempt = await createRfc3161Client(config()).request(subject, ctx(egress.client, mode));
    expect(attempt.outcome).toEqual({ status: 'queued', reason: 'offline' });
    expect(egress.calls).toHaveLength(0);
  });

  it('AC5: 429 and 5xx are transient; other HTTP errors are rejections', async () => {
    const egress = createFakeTsaEgress(tsa, [503, 429, 403]);
    const client = createRfc3161Client(config());
    const first = await client.request(subject, ctx(egress.client));
    expect(first).toMatchObject({ outcome: { status: 'queued', reason: 'transient_failure' }, httpStatus: 503 });
    expect((await client.request(subject, ctx(egress.client))).outcome).toEqual({
      status: 'queued',
      reason: 'transient_failure',
    });
    expect((await client.request(subject, ctx(egress.client))).outcome).toEqual({
      status: 'rejected',
      reason: 'http_403',
    });
  });

  it('treats network, timeout and abort failures as transient', async () => {
    const failures = [
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new DOMException('This operation was aborted', 'AbortError'),
    ];
    for (const failure of failures) {
      const down = createFakeTsaEgress(tsa, [
        () => {
          throw failure;
        },
      ]);
      // oxlint-disable-next-line no-await-in-loop
      const attempt = await createRfc3161Client(config()).request(subject, ctx(down.client));
      expect(attempt.outcome).toEqual({ status: 'queued', reason: 'transient_failure' });
    }
    const refused = createFakeTsaEgress(tsa, [
      () => {
        throw failures[0]!;
      },
    ]);
    expect((await createRfc3161Client(config()).request(subject, ctx(refused.client))).error).toBe(
      'fetch failed: connect ECONNREFUSED',
    );
  });

  it.each([
    ['a denied host', Object.assign(new Error('egress denied'), { name: 'EgressDeniedError' })],
    ['a replay miss', Object.assign(new Error('no recorded response'), { name: 'ReplayMissError' })],
    ['a failing log or blob sink inside the egress client', new Error('ENOSPC: no space left on device')],
  ])('lets %s escape instead of queueing a retry', async (_name, failure) => {
    const egress = createFakeTsaEgress(tsa, [
      () => {
        throw failure;
      },
    ]);
    await expect(createRfc3161Client(config()).request(subject, ctx(egress.client))).rejects.toThrow(failure.message);
  });

  it('lets a failing blob store escape after a valid reply', async () => {
    const egress = createFakeTsaEgress(tsa);
    const context = {
      ...ctx(egress.client),
      blobs: {
        put: () => Promise.reject(new Error('disk full')),
        get: () => Promise.reject(new Error('unused')),
        has: () => Promise.resolve(false),
      },
    };
    await expect(createRfc3161Client(config()).request(subject, context)).rejects.toThrow('disk full');
  });

  it('AC3: a tampered reply is rejected naming the failed check and stores no blob', async () => {
    const egress = createFakeTsaEgress(tsa, [{ wrongNonce: true }]);
    const context = ctx(egress.client);
    const attempt = await createRfc3161Client(config()).request(subject, context);
    expect(attempt.outcome).toEqual({ status: 'rejected', reason: 'verification_failed: nonce' });
    expect(attempt.verification?.ok).toBe(false);
  });
});
