/**
 * RFC 3161 `TimeStampReq` builder: a SHA-256 message imprint over the 32 digest bytes (AlgorithmIdentifier without
 * parameters, RFC 5754), an optional policy, a positive nonce and `certReq true`. The request carries nothing else.
 */
import type { Sha256Hex } from '@olcys/core';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export const SHA256_OID = '2.16.840.1.101.3.4.2.1';
export const ID_CT_TST_INFO = '1.2.840.113549.1.9.16.1.4';
export const ID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
export const MAX_NONCE = (1n << 63n) - 1n;

export function digestBytes(digest: Sha256Hex): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('a SHA-256 digest is 64 lower-case hex characters');
  return Uint8Array.from(Buffer.from(digest, 'hex'));
}

/** The DER INTEGER content of a non-negative bigint (a leading zero byte keeps it positive). */
export function nonceBytes(nonce: bigint): Uint8Array<ArrayBuffer> {
  let hex = nonce.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (Number.parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Random positive 63-bit nonce. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  const value = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return value === 0n ? 1n : value;
}

export function buildTimeStampReq(digest: Sha256Hex, options: { nonce: bigint; policyOid?: string }): Uint8Array {
  if (options.nonce <= 0n || options.nonce > MAX_NONCE) throw new Error('the nonce must be positive and below 2^63');
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
      hashedMessage: new asn1js.OctetString({ valueHex: digestBytes(digest) }),
    }),
    ...(options.policyOid ? { reqPolicy: options.policyOid } : {}),
    nonce: new asn1js.Integer({ valueHex: nonceBytes(options.nonce) }),
    certReq: true,
  });
  return new Uint8Array(request.toSchema().toBER(false));
}
