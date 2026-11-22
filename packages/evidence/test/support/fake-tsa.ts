/**
 * A fake time-stamp authority for tests. The CA and TSA key pairs are generated in memory at test time (WebCrypto) and
 * never written anywhere; the PEM certificates are the only thing a test may hand to a verifier or to openssl.
 */
import { createHash } from 'node:crypto';
import type { EgressClient, EgressRequest, EgressResponse } from '@olcys/core';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { ID_CT_TST_INFO, ID_KP_TIME_STAMPING, SHA256_OID, nonceBytes } from '../../src/tsa-request.ts';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface TestAuthority {
  certificate: pkijs.Certificate;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  pem: string;
}

const toPem = (cert: pkijs.Certificate): string => {
  const b64 = Buffer.from(cert.toSchema(true).toBER(false)).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;
};

const name = (cert: pkijs.Certificate, target: 'subject' | 'issuer', cn: string): void => {
  cert[target].typesAndValues.push(
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }),
  );
};

const bits = (byte: number, unused: number) =>
  new asn1js.BitString({ valueHex: Uint8Array.of(byte).buffer, unusedBits: unused });

function extension(extnID: string, critical: boolean, value: asn1js.AsnType, parsedValue?: unknown): pkijs.Extension {
  return new pkijs.Extension({
    extnID,
    critical,
    extnValue: value.toBER(false),
    ...(parsedValue ? { parsedValue: parsedValue as never } : {}),
  });
}

interface CertOptions {
  cn: string;
  serial: number;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  /** Signing key and the issuer's name; undefined for a self-signed certificate. */
  issuer?: TestAuthority;
  /** `critical` EKU timeStamping, `none`, or a non-critical one. */
  eku?: 'critical' | 'none' | 'non_critical' | 'multi_purpose';
}

async function makeCertificate(options: CertOptions): Promise<TestAuthority> {
  const keys = (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  };
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: options.serial });
  name(cert, 'subject', options.cn);
  if (options.issuer) cert.issuer = options.issuer.certificate.subject;
  else name(cert, 'issuer', options.cn);
  cert.notBefore.value = options.notBefore;
  cert.notAfter.value = options.notAfter;
  const basic = new pkijs.BasicConstraints({ cA: options.ca });
  cert.extensions = [
    extension('2.5.29.19', true, basic.toSchema(), basic),
    extension('2.5.29.15', true, options.ca ? bits(0x04, 2) : bits(0x80, 7)),
  ];
  if (!options.ca && options.eku !== 'none') {
    const eku = new pkijs.ExtKeyUsage({
      keyPurposes: options.eku === 'multi_purpose' ? [ID_KP_TIME_STAMPING, '1.3.6.1.5.5.7.3.1'] : [ID_KP_TIME_STAMPING],
    });
    cert.extensions.push(extension('2.5.29.37', options.eku !== 'non_critical', eku.toSchema(), eku));
  }
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign((options.issuer ?? { privateKey: keys.privateKey }).privateKey, 'SHA-256');
  return { certificate: cert, privateKey: keys.privateKey, publicKey: keys.publicKey, pem: toPem(cert) };
}

export interface TsaKnobs {
  /** PKIStatus of the reply (0 granted, 2 rejection ...); a non-granted reply carries no token. */
  status?: number;
  genTime?: Date;
  /** Echoes a different digest in the TSTInfo. */
  wrongImprint?: boolean;
  /** Echoes a different nonce. */
  wrongNonce?: boolean;
  /** The TSA certificate lacks the EKU / has a non-critical one. */
  eku?: 'critical' | 'none' | 'non_critical' | 'multi_purpose';
  /** Signs with a certificate of a CA that is not the trusted one. */
  unknownCa?: boolean;
  /** The TSA certificate expires before `genTime`. */
  expiredAtGenTime?: boolean;
  /** Uses `signingCertificate` (SHA-1) instead of `signingCertificateV2`; a wrong hash when `wrongEssHash`. */
  wrongEssHash?: boolean;
}

export interface FakeTsa {
  caPem: string;
  tsaPem: string;
  /** Another CA the verifier does not trust. */
  otherCaPem: string;
  respond(requestDer: Uint8Array, knobs?: TsaKnobs): Promise<Uint8Array>;
}

const FIXED_GEN_TIME = new Date('2026-11-21T12:00:05.000Z');

export async function createFakeTsa(): Promise<FakeTsa> {
  const notBefore = new Date('2025-01-01T00:00:00Z');
  const notAfter = new Date('2035-01-01T00:00:00Z');
  const ca = await makeCertificate({ cn: 'Test TSA Root CA', serial: 1, notBefore, notAfter, ca: true });
  const otherCa = await makeCertificate({ cn: 'Other Test Root CA', serial: 1, notBefore, notAfter, ca: true });
  const tsa = {
    critical: await makeCertificate({ cn: 'Test TSA', serial: 2, notBefore, notAfter, ca: false, issuer: ca }),
    none: await makeCertificate({ cn: 'Test TSA', serial: 3, notBefore, notAfter, ca: false, issuer: ca, eku: 'none' }),
    non_critical: await makeCertificate({
      cn: 'Test TSA',
      serial: 4,
      notBefore,
      notAfter,
      ca: false,
      issuer: ca,
      eku: 'non_critical',
    }),
    multi_purpose: await makeCertificate({
      cn: 'Test TSA',
      serial: 7,
      notBefore,
      notAfter,
      ca: false,
      issuer: ca,
      eku: 'multi_purpose',
    }),
    unknown: await makeCertificate({ cn: 'Test TSA', serial: 5, notBefore, notAfter, ca: false, issuer: otherCa }),
    expired: await makeCertificate({
      cn: 'Test TSA',
      serial: 6,
      notBefore,
      notAfter: new Date('2026-06-01T00:00:00Z'),
      ca: false,
      issuer: ca,
    }),
  };

  async function respond(requestDer: Uint8Array, knobs: TsaKnobs = {}): Promise<Uint8Array> {
    const request = pkijs.TimeStampReq.fromBER(Uint8Array.from(requestDer));
    const status = knobs.status ?? 0;
    if (status !== 0) {
      return new Uint8Array(
        new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status }) }).toSchema().toBER(false),
      );
    }
    const signer = knobs.unknownCa ? tsa.unknown : knobs.expiredAtGenTime ? tsa.expired : tsa[knobs.eku ?? 'critical'];
    const hashed = new Uint8Array(request.messageImprint.hashedMessage.valueBlock.valueHexView);
    const echoed = knobs.wrongImprint ? Uint8Array.from(hashed, (b) => b ^ 0xff) : hashed;
    const nonce = request.nonce
      ? BigInt(`0x${Buffer.from(request.nonce.valueBlock.valueHexView).toString('hex')}`)
      : 0n;
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4.1',
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
        hashedMessage: new asn1js.OctetString({ valueHex: echoed }),
      }),
      serialNumber: new asn1js.Integer({ value: Math.floor(Math.random() * 1_000_000) + 1 }),
      genTime: knobs.genTime ?? FIXED_GEN_TIME,
      ...(request.nonce
        ? { nonce: new asn1js.Integer({ valueHex: nonceBytes(knobs.wrongNonce ? nonce + 1n : nonce) }) }
        : {}),
    });
    const certDer = new Uint8Array(signer.certificate.toSchema(true).toBER(false));
    const certHash = createHash('sha256').update(certDer).digest();
    const wrong = knobs.wrongEssHash ? Uint8Array.from(certHash, (b) => b ^ 0xff) : certHash;
    const essCertId = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: wrong })] });
    const tstDer = tst.toSchema().toBER(false);
    const signedData = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: ID_CT_TST_INFO,
        eContent: new asn1js.OctetString({ valueHex: tstDer }),
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: signer.certificate.issuer,
            serialNumber: signer.certificate.serialNumber,
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.3',
                values: [new asn1js.ObjectIdentifier({ value: ID_CT_TST_INFO })],
              }),
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.4',
                values: [
                  new asn1js.OctetString({ valueHex: createHash('sha256').update(new Uint8Array(tstDer)).digest() }),
                ],
              }),
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.16.2.47',
                values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertId] })] })],
              }),
            ],
          }),
        }),
      ],
      certificates: [signer.certificate],
    });
    await signedData.sign(signer.privateKey, 0, 'SHA-256');
    const token = new pkijs.ContentInfo({
      contentType: pkijs.ContentInfo.SIGNED_DATA,
      content: signedData.toSchema(true),
    });
    const response = new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: new pkijs.ContentInfo({ schema: token.toSchema() }),
    });
    return new Uint8Array(response.toSchema().toBER(false));
  }

  return { caPem: ca.pem, tsaPem: tsa.critical.pem, otherCaPem: otherCa.pem, respond };
}

export interface FakeTsaEgress {
  client: EgressClient;
  calls: EgressRequest[];
  /** Responses are served in order (the last one repeats); a number is an HTTP error status, a function an exception. */
  script: Array<TsaKnobs | number | (() => never)>;
}

/** An `EgressClient` that routes POSTs to the fake TSA and records every request. */
export function createFakeTsaEgress(tsa: FakeTsa, script: FakeTsaEgress['script'] = [{}]): FakeTsaEgress {
  const calls: EgressRequest[] = [];
  const state = { index: 0 };
  const client: EgressClient = {
    async fetch(request) {
      calls.push(request);
      const step = script[Math.min(state.index++, script.length - 1)] ?? {};
      if (typeof step === 'function') return step();
      const headers = { 'content-type': 'application/timestamp-reply' };
      const respondWith = (status: number, body: Uint8Array): EgressResponse =>
        ({
          status,
          finalUrl: request.url,
          headers,
          body,
          text: () => new TextDecoder().decode(body),
          json: () => JSON.parse(new TextDecoder().decode(body)),
          provenance: { fetchId: `0190a000-0000-7000-8000-${String(calls.length).padStart(12, '0')}` },
        }) as unknown as EgressResponse;
      if (typeof step === 'number') return respondWith(step, new Uint8Array());
      return respondWith(200, await tsa.respond(request.body as Uint8Array, step));
    },
  };
  return { client, calls, script };
}
