import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { buildTimeStampReq, randomNonce, SHA256_OID } from '../src/index.ts';

const DIGEST = 'ab'.repeat(32);

const decode = (der: Uint8Array) => pkijs.TimeStampReq.fromBER(Uint8Array.from(der));

describe('buildTimeStampReq (AC1)', () => {
  it('encodes version 1, SHA-256 without parameters, the digest bytes, certReq true and the nonce', () => {
    const der = buildTimeStampReq(DIGEST, { nonce: 0x1234567890abcdefn });
    expect(der.byteLength).toBeLessThan(120);
    const req = decode(der);
    expect(req.version).toBe(1);
    expect(req.messageImprint.hashAlgorithm.algorithmId).toBe(SHA256_OID);
    expect(req.messageImprint.hashAlgorithm.algorithmParams).toBeUndefined();
    expect(Buffer.from(req.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex')).toBe(DIGEST);
    expect(req.certReq).toBe(true);
    expect(BigInt(`0x${Buffer.from((req.nonce as asn1js.Integer).valueBlock.valueHexView).toString('hex')}`)).toBe(
      0x1234567890abcdefn,
    );
    expect(req.extensions).toBeUndefined();
    expect(req.reqPolicy).toBeUndefined();
  });

  it('keeps a nonce with the high bit set positive', () => {
    const req = decode(buildTimeStampReq(DIGEST, { nonce: 0x80n }));
    expect(Buffer.from((req.nonce as asn1js.Integer).valueBlock.valueHexView).toString('hex')).toBe('0080');
  });

  it('adds reqPolicy only when configured', () => {
    expect(decode(buildTimeStampReq(DIGEST, { nonce: 1n, policyOid: '1.2.3.4' })).reqPolicy).toBe('1.2.3.4');
  });

  it('rejects a bad digest or nonce, and random nonces are positive 63-bit values', () => {
    expect(() => buildTimeStampReq('xyz', { nonce: 1n })).toThrow('64 lower-case hex');
    expect(() => buildTimeStampReq(DIGEST, { nonce: 0n })).toThrow('positive');
    expect(() => buildTimeStampReq(DIGEST, { nonce: 1n << 63n })).toThrow('positive');
    for (let i = 0; i < 50; i += 1) {
      const n = randomNonce();
      expect(n > 0n && n < 1n << 63n).toBe(true);
    }
  });
});
