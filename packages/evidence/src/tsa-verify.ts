/**
 * RFC 3161 `TimeStampResp` verifier. Every check is recorded (pass or fail, with detail): PKIStatus, HTTP content type,
 * message imprint, nonce, policy, CMS signature, critical `id-kp-timeStamping` EKU of the signer, ESSCertID(v2) of the
 * signer, the certificate chain to a configured anchor and the signer's validity at `genTime`. Revocation is not
 * checked (the TSA's own certificate is short of a CRL/OCSP service in the demo); the report states that.
 */
import { createHash } from 'node:crypto';
import type { IsoDateTime, Sha256Hex } from '@olcys/core';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { parseCertificates } from './tsa-anchors.ts';
import { digestBytes, ID_CT_TST_INFO, ID_KP_TIME_STAMPING, SHA256_OID } from './tsa-request.ts';

export const TSA_CHECKS = [
  'status_granted',
  'content_type',
  'imprint',
  'nonce',
  'policy',
  'signature',
  'eku',
  'ess_cert_id',
  'chain',
  'validity',
] as const;
export type TsaCheck = (typeof TSA_CHECKS)[number];

export interface TimestampVerification {
  ok: boolean;
  checks: { name: TsaCheck; passed: boolean; detail?: string }[];
  genTime?: IsoDateTime;
  serialNumber?: string;
  policyOid?: string;
  tsaName?: string;
}

const OID_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12';
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const REPLY_MEDIA_TYPE = 'application/timestamp-reply';
const NAME_OIDS: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.6': 'C', '2.5.4.11': 'OU' };

const bytesEqual = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Decimal text of a DER INTEGER (two's complement). */
function integerText(integer: asn1js.Integer): string {
  const bytes = new Uint8Array(integer.valueBlock.valueHexView);
  if (bytes.length === 0) return '0';
  const unsigned = BigInt(`0x${toHex(bytes)}`);
  const negative = (bytes[0] ?? 0) >= 0x80;
  return (negative ? unsigned - (1n << BigInt(bytes.length * 8)) : unsigned).toString();
}

function subjectText(cert: pkijs.Certificate): string {
  return cert.subject.typesAndValues
    .map((tv) => `${NAME_OIDS[tv.type] ?? tv.type}=${String(tv.value.valueBlock.value ?? '')}`)
    .join(', ');
}

function findSigner(signerInfo: pkijs.SignerInfo, certs: pkijs.Certificate[]): pkijs.Certificate | undefined {
  const sid = signerInfo.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber));
  }
  const keyId = (sid as asn1js.Primitive).valueBlock?.valueHexView;
  if (!keyId) return undefined;
  return certs.find((c) =>
    c.extensions?.some(
      (e) =>
        e.extnID === OID_SUBJECT_KEY_IDENTIFIER &&
        bytesEqual(
          new Uint8Array((e.parsedValue as asn1js.OctetString).valueBlock.valueHexView),
          new Uint8Array(keyId),
        ),
    ),
  );
}

/** Checks the signer certificate hash against the signed `signingCertificate(V2)` attribute. */
function checkEssCertId(signerInfo: pkijs.SignerInfo, signer: pkijs.Certificate): { passed: boolean; detail?: string } {
  const attribute = signerInfo.signedAttrs?.attributes.find(
    (a) => a.type === OID_SIGNING_CERTIFICATE || a.type === OID_SIGNING_CERTIFICATE_V2,
  );
  const value = attribute?.values[0];
  if (!attribute || !value) return { passed: false, detail: 'the signingCertificate attribute is missing' };
  const parsed = asn1js.fromBER(value.toBER());
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    return { passed: false, detail: 'the signingCertificate attribute is malformed' };
  }
  const first = (parsed.result.valueBlock.value[0] as asn1js.Sequence | undefined)?.valueBlock.value[0];
  if (!(first instanceof asn1js.Sequence)) return { passed: false, detail: 'no ESSCertID in the attribute' };
  const parts = first.valueBlock.value;
  const v2 = attribute.type === OID_SIGNING_CERTIFICATE_V2;
  let algorithm = v2 ? 'sha256' : 'sha1';
  let hashPart = parts[0];
  if (v2 && parts[0] instanceof asn1js.Sequence) {
    const oid = (parts[0].valueBlock.value[0] as asn1js.ObjectIdentifier | undefined)?.valueBlock.toString();
    const known: Record<string, string> = {
      '1.3.14.3.2.26': 'sha1',
      '2.16.840.1.101.3.4.2.1': 'sha256',
      '2.16.840.1.101.3.4.2.2': 'sha384',
      '2.16.840.1.101.3.4.2.3': 'sha512',
    };
    algorithm = known[oid ?? ''] ?? 'unsupported';
    hashPart = parts[1];
  }
  if (algorithm === 'unsupported' || !(hashPart instanceof asn1js.OctetString)) {
    return { passed: false, detail: 'unsupported or malformed ESSCertID hash' };
  }
  const expected = new Uint8Array(hashPart.valueBlock.valueHexView);
  const actual = createHash(algorithm)
    .update(new Uint8Array(signer.toSchema().toBER(false)))
    .digest();
  return bytesEqual(expected, actual)
    ? { passed: true }
    : { passed: false, detail: 'the hash of the signer certificate differs from the signed ESSCertID' };
}

function tstInfoBytes(signedData: pkijs.SignedData): Uint8Array<ArrayBuffer> | undefined {
  const content = signedData.encapContentInfo.eContent;
  if (!content) return undefined;
  const raw = content.valueBlock.value.length
    ? Buffer.concat(
        (content.valueBlock.value as asn1js.OctetString[]).map((part) => Buffer.from(part.valueBlock.valueHexView)),
      )
    : Buffer.from(content.valueBlock.valueHexView);
  return Uint8Array.from(raw);
}

/**
 * Verifies the CMS signature over the signed attributes and their messageDigest over the TSTInfo. `SignedData.verify` of
 * pkijs cannot be used: for a TSTInfo it insists on the original timestamped data, whereas the system only keeps the
 * digest (the imprint is compared separately). Returns an error text, or undefined when valid.
 */
async function checkCmsSignature(
  signerInfo: pkijs.SignerInfo,
  signer: pkijs.Certificate,
  tstBytes: Uint8Array<ArrayBuffer>,
): Promise<string | undefined> {
  const engine = pkijs.getCrypto(true);
  const attrs = signerInfo.signedAttrs;
  if (!attrs) return 'the signer has no signed attributes';
  const algorithm = engine.getAlgorithmByOID<{ name: string }>(signerInfo.digestAlgorithm.algorithmId, true);
  const contentType = attrs.attributes.find((a) => a.type === '1.2.840.113549.1.9.3')?.values[0];
  if (!(contentType instanceof asn1js.ObjectIdentifier) || contentType.valueBlock.toString() !== ID_CT_TST_INFO) {
    return 'the content-type attribute is not id-ct-TSTInfo';
  }
  const digestValue = attrs.attributes.find((a) => a.type === '1.2.840.113549.1.9.4')?.values[0];
  if (!(digestValue instanceof asn1js.OctetString)) return 'the message-digest attribute is missing';
  const digest = new Uint8Array(await engine.digest(algorithm.name, tstBytes));
  if (!bytesEqual(digest, new Uint8Array(digestValue.valueBlock.valueHexView))) {
    return 'the message-digest attribute does not match the TSTInfo';
  }
  const rsa = signerInfo.signatureAlgorithm.algorithmId === '1.2.840.113549.1.1.1';
  const valid = await engine.verifyWithPublicKey(
    attrs.encodedValue,
    signerInfo.signature,
    signer.subjectPublicKeyInfo,
    signerInfo.signatureAlgorithm,
    ...(rsa ? [algorithm.name] : []),
  );
  return valid ? undefined : 'the CMS signature is invalid';
}

export async function verifyTimeStampResp(
  der: Uint8Array,
  expected: { digest: Sha256Hex; nonce?: bigint; policyOid?: string; contentType?: string },
  trust: { anchorsPem: string[] },
): Promise<TimestampVerification> {
  const checks: TimestampVerification['checks'] = [];
  const record = (name: TsaCheck, passed: boolean, detail?: string): boolean => {
    checks.push({ name, passed, ...(detail ? { detail } : {}) });
    return passed;
  };
  const result = (extra: Partial<TimestampVerification> = {}): TimestampVerification => ({
    ok: checks.every((c) => c.passed),
    checks,
    ...extra,
  });

  if (expected.contentType !== undefined) {
    const type = expected.contentType.split(';')[0]?.trim().toLowerCase();
    record('content_type', type === REPLY_MEDIA_TYPE, type === REPLY_MEDIA_TYPE ? undefined : `got "${type}"`);
  }

  let response: pkijs.TimeStampResp;
  try {
    response = pkijs.TimeStampResp.fromBER(Uint8Array.from(der));
  } catch (error) {
    record('status_granted', false, `unparseable TimeStampResp: ${String(error)}`);
    return result();
  }
  const status = response.status.status;
  if (status !== 0 && status !== 1) {
    record('status_granted', false, `PKIStatus ${status}`);
    return result();
  }
  if (!response.timeStampToken) {
    record('status_granted', false, 'granted without a token');
    return result();
  }
  record('status_granted', true, `PKIStatus ${status}`);

  let signedData: pkijs.SignedData;
  let tstInfo: pkijs.TSTInfo | undefined;
  let tstBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    signedData = new pkijs.SignedData({ schema: response.timeStampToken.content });
    tstBytes = signedData.encapContentInfo.eContentType === ID_CT_TST_INFO ? tstInfoBytes(signedData) : undefined;
    tstInfo = tstBytes ? pkijs.TSTInfo.fromBER(tstBytes) : undefined;
  } catch (error) {
    record('signature', false, `unparseable token: ${String(error)}`);
    return result();
  }
  if (!tstInfo || !tstBytes) {
    record('signature', false, 'the token does not carry a TSTInfo');
    return result();
  }

  const { messageImprint } = tstInfo;
  const params = messageImprint.hashAlgorithm.algorithmParams;
  const imprintOk =
    messageImprint.hashAlgorithm.algorithmId === SHA256_OID &&
    (params === undefined || params instanceof asn1js.Null) &&
    bytesEqual(new Uint8Array(messageImprint.hashedMessage.valueBlock.valueHexView), digestBytes(expected.digest));
  record('imprint', imprintOk, imprintOk ? undefined : 'the message imprint differs from the requested SHA-256 digest');
  if (expected.nonce !== undefined) {
    const nonce = tstInfo.nonce ? BigInt(integerText(tstInfo.nonce)) : undefined;
    record('nonce', nonce === expected.nonce, nonce === expected.nonce ? undefined : 'the nonce differs or is missing');
  }
  if (expected.policyOid !== undefined) {
    record('policy', tstInfo.policy === expected.policyOid, `got ${tstInfo.policy}`);
  }

  const genTime = tstInfo.genTime;
  const certs = (signedData.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  const signerInfo = signedData.signerInfos[0];
  const signer = signerInfo ? findSigner(signerInfo, certs) : undefined;

  let signatureOk = false;
  let signatureDetail: string | undefined;
  if (!signerInfo || !signer) {
    signatureDetail = 'the signer certificate is not in the token';
  } else {
    try {
      signatureDetail = await checkCmsSignature(signerInfo, signer, tstBytes);
      signatureOk = signatureDetail === undefined;
    } catch (error) {
      signatureDetail = error instanceof Error ? error.message : String(error);
    }
  }
  record('signature', signatureOk, signatureDetail);

  const extra: Partial<TimestampVerification> = {
    genTime: genTime.toISOString(),
    serialNumber: integerText(tstInfo.serialNumber),
    policyOid: tstInfo.policy,
    ...(signer ? { tsaName: subjectText(signer) } : {}),
  };
  if (!signer || !signerInfo) {
    for (const name of ['eku', 'ess_cert_id', 'chain', 'validity'] as const)
      record(name, false, 'no signer certificate');
    return result(extra);
  }

  const eku = signer.extensions?.find((e) => e.extnID === OID_EXT_KEY_USAGE);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  const ekuOk = eku?.critical === true && purposes.includes(ID_KP_TIME_STAMPING);
  record(
    'eku',
    ekuOk,
    ekuOk ? undefined : 'the signer certificate lacks a critical id-kp-timeStamping extended key usage',
  );

  const ess = checkEssCertId(signerInfo, signer);
  record('ess_cert_id', ess.passed, ess.detail);

  const anchors = parseCertificates(trust.anchorsPem);
  const others = certs.filter((c) => c !== signer);
  let chainOk = false;
  let chainDetail: string | undefined;
  if (anchors.length === 0) {
    chainDetail = 'no trust anchors configured';
  } else {
    try {
      const engine = new pkijs.CertificateChainValidationEngine({
        trustedCerts: anchors,
        certs: [...others, signer],
        checkDate: genTime,
      });
      const chain = await engine.verify({ passedWhenNotRevValues: true });
      chainOk = chain.result;
      if (!chainOk) chainDetail = chain.resultMessage;
    } catch (error) {
      chainDetail = error instanceof Error ? error.message : String(error);
    }
  }
  record('chain', chainOk, chainDetail);

  const validOk = signer.notBefore.value <= genTime && genTime <= signer.notAfter.value;
  record(
    'validity',
    validOk,
    validOk
      ? undefined
      : `genTime ${genTime.toISOString()} is outside ${signer.notBefore.value.toISOString()}..${signer.notAfter.value.toISOString()}`,
  );
  return result(extra);
}
