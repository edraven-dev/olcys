import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTimeStampReq, verifyTimeStampResp, type TsaCheck } from '../src/index.ts';
import { createFakeTsa, type FakeTsa, type TsaKnobs } from './support/fake-tsa.ts';

const DIGEST = 'cd'.repeat(32);
const NONCE = 987654321012345n;
const GEN_TIME = new Date('2026-11-21T12:00:05.000Z');

let tsa: FakeTsa;
beforeAll(async () => {
  tsa = await createFakeTsa();
});

const reply = (knobs: TsaKnobs = {}) =>
  tsa.respond(buildTimeStampReq(DIGEST, { nonce: NONCE }), { genTime: GEN_TIME, ...knobs });
const verify = async (knobs: TsaKnobs = {}, trusted?: string) =>
  verifyTimeStampResp(await reply(knobs), { digest: DIGEST, nonce: NONCE }, { anchorsPem: [trusted ?? tsa.caPem] });
const failed = (v: { checks: { name: TsaCheck; passed: boolean }[] }) =>
  v.checks.filter((c) => !c.passed).map((c) => c.name);

describe('verifyTimeStampResp', () => {
  it('accepts a genuine reply and reports genTime, serial, policy and TSA name (AC8)', async () => {
    const v = await verify();
    expect(failed(v)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.genTime).toBe('2026-11-21T12:00:05.000Z');
    expect(v.policyOid).toBe('1.2.3.4.1');
    expect(v.tsaName).toBe('CN=Test TSA');
    expect(v.serialNumber).toMatch(/^\d+$/);
    expect(v.checks.map((c) => c.name)).toEqual([
      'status_granted',
      'imprint',
      'nonce',
      'signature',
      'eku',
      'ess_cert_id',
      'chain',
      'validity',
    ]);
  });

  it.each<[string, TsaKnobs, TsaCheck[]]>([
    ['wrong imprint', { wrongImprint: true }, ['imprint']],
    ['wrong nonce', { wrongNonce: true }, ['nonce']],
    ['PKIStatus rejection', { status: 2 }, ['status_granted']],
    ['signer without the EKU', { eku: 'none' }, ['eku']],
    ['signer with a non-critical EKU', { eku: 'non_critical' }, ['eku']],
    ['unknown CA', { unknownCa: true }, ['chain']],
    ['certificate expired at genTime', { expiredAtGenTime: true }, ['chain', 'validity']],
    ['ESSCertID of another certificate', { wrongEssHash: true }, ['ess_cert_id']],
  ])('AC3: %s fails the named check', async (_name, knobs, expected) => {
    const v = await verify(knobs);
    expect(v.ok).toBe(false);
    expect(failed(v)).toEqual(expected);
  });

  it('fails the chain check against a different anchor and the content type check on a wrong media type', async () => {
    expect(failed(await verify({}, tsa.otherCaPem))).toEqual(['chain']);
    const v = await verifyTimeStampResp(
      await reply(),
      { digest: DIGEST, nonce: NONCE, contentType: 'text/html' },
      { anchorsPem: [tsa.caPem] },
    );
    expect(failed(v)).toEqual(['content_type']);
  });

  it('fails on a policy mismatch and on a tampered signature', async () => {
    const v = await verifyTimeStampResp(
      await reply(),
      { digest: DIGEST, nonce: NONCE, policyOid: '9.9.9' },
      { anchorsPem: [tsa.caPem] },
    );
    expect(failed(v)).toEqual(['policy']);
    const der = Uint8Array.from(await reply());
    // Change the policy OID (2a 03 04 01) inside the signed TSTInfo.
    const at = Buffer.from(der).indexOf(Buffer.from([0x2a, 0x03, 0x04, 0x01]));
    expect(at).toBeGreaterThan(0);
    der[at + 3] = 0x02;
    const tampered = await verifyTimeStampResp(der, { digest: DIGEST, nonce: NONCE }, { anchorsPem: [tsa.caPem] });
    expect(tampered.ok).toBe(false);
  });

  it('rejects garbage without throwing', async () => {
    const v = await verifyTimeStampResp(Uint8Array.of(1, 2, 3), { digest: DIGEST }, { anchorsPem: [tsa.caPem] });
    expect(v.ok).toBe(false);
    expect(failed(v)).toEqual(['status_granted']);
  });
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
describe.skipIf(!hasOpenssl)('openssl cross-check (AC8)', () => {
  it('`openssl ts -verify` accepts the reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olcys-tsa-'));
    try {
      writeFileSync(join(dir, 'reply.tsr'), await reply());
      writeFileSync(join(dir, 'test-ca.pem'), tsa.caPem);
      writeFileSync(join(dir, 'tsa.pem'), tsa.tsaPem);
      const run = spawnSync(
        'openssl',
        [
          'ts',
          '-verify',
          '-digest',
          DIGEST,
          '-in',
          join(dir, 'reply.tsr'),
          '-CAfile',
          join(dir, 'test-ca.pem'),
          '-untrusted',
          join(dir, 'tsa.pem'),
        ],
        { encoding: 'utf8' },
      );
      expect(run.stderr + run.stdout).toContain('OK');
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
