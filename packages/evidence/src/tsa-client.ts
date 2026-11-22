/**
 * RFC 3161 client over `EgressClient`: POSTs the DER request to the configured TSA and verifies the reply. Only the
 * SHA-256 digest and a random nonce leave the system. Only `live` mode contacts the TSA; `offline` and `replay` return
 * a queued outcome without any egress call (a random nonce can never match a recorded cassette).
 */
import type { Id, RunContext, SourceId, TimestampOutcome, TimestampSubject, TimestampToken } from '@olcys/core';
import { buildTimeStampReq, randomNonce } from './tsa-request.ts';
import { verifyTimeStampResp, type TimestampVerification } from './tsa-verify.ts';

export const TSA_REQUEST_MEDIA_TYPE = 'application/timestamp-query';
export const TSA_REPLY_MEDIA_TYPE = 'application/timestamp-reply';

export interface Rfc3161Config {
  tsaUrl: string;
  sourceId: SourceId;
  policyOid?: string;
  /** True only for a qualified TSA from the EU Trusted List. */
  qualified: boolean;
  trustAnchorsPem: string[];
  timeoutMs: number;
  maxClockSkewSeconds: number;
  /** Value of the `Authorization` header for a contracted TSA (from the environment only). */
  authorization?: string;
}

export interface TsaAttempt {
  outcome: TimestampOutcome;
  nonce?: bigint;
  httpStatus?: number;
  fetchId?: Id;
  verification?: TimestampVerification;
  error?: string;
}

export interface Rfc3161Client {
  request(subject: TimestampSubject, ctx: Pick<RunContext, 'http' | 'blobs' | 'clock' | 'mode'>): Promise<TsaAttempt>;
}

export function createRfc3161Client(config: Rfc3161Config, random: () => bigint = randomNonce): Rfc3161Client {
  return {
    async request(subject, ctx) {
      if (ctx.mode !== 'live') return { outcome: { status: 'queued', reason: 'offline' } };
      const nonce = random();
      const body = buildTimeStampReq(subject.digest, {
        nonce,
        ...(config.policyOid ? { policyOid: config.policyOid } : {}),
      });
      let response;
      try {
        response = await ctx.http.fetch({
          url: config.tsaUrl,
          method: 'POST',
          headers: {
            'content-type': TSA_REQUEST_MEDIA_TYPE,
            accept: TSA_REPLY_MEDIA_TYPE,
            ...(config.authorization ? { authorization: config.authorization } : {}),
          },
          body,
          sourceId: config.sourceId,
          purpose: 'RFC 3161 timestamp of a SHA-256 digest',
          containsIdentifier: false,
          timeoutMs: config.timeoutMs,
          secretParams: ['authorization'],
          ...(subject.runId ? { runId: subject.runId } : {}),
        });
      } catch (error) {
        // A denied host or a replay miss is a configuration problem (classes of @olcys/http, matched by name so that
        // this package depends on the core contracts only), not a transient failure.
        if (error instanceof Error && (error.name === 'EgressDeniedError' || error.name === 'ReplayMissError')) {
          throw error;
        }
        return {
          outcome: { status: 'queued', reason: 'transient_failure' },
          nonce,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const base = { nonce, httpStatus: response.status, fetchId: response.provenance.fetchId };
      if (response.status === 429 || response.status >= 500) {
        return {
          ...base,
          outcome: { status: 'queued', reason: 'transient_failure' },
          error: `HTTP ${response.status}`,
        };
      }
      if (response.status !== 200) {
        const reason = `http_${response.status}`;
        return { ...base, outcome: { status: 'rejected', reason }, error: reason };
      }

      const contentType = Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      const verification = await verifyTimeStampResp(
        response.body,
        {
          digest: subject.digest,
          nonce,
          contentType,
          ...(config.policyOid ? { policyOid: config.policyOid } : {}),
        },
        { anchorsPem: config.trustAnchorsPem },
      );
      if (!verification.ok || !verification.genTime) {
        const failed = verification.checks.filter((c) => !c.passed).map((c) => c.name);
        const reason = `verification_failed: ${failed.join(', ')}`;
        return { ...base, verification, outcome: { status: 'rejected', reason }, error: reason };
      }
      const blob = await ctx.blobs.put(response.body, TSA_REPLY_MEDIA_TYPE);
      const token: TimestampToken = {
        tsaUrl: config.tsaUrl,
        token: blob,
        genTime: verification.genTime,
        hashAlgorithm: 'sha256',
        messageImprint: subject.digest,
        ...(verification.serialNumber ? { serialNumber: verification.serialNumber } : {}),
        ...(verification.policyOid ? { policyOid: verification.policyOid } : {}),
        ...(verification.tsaName ? { tsaName: verification.tsaName } : {}),
        qualified: config.qualified,
        ...(subject.referenceTime
          ? { skewSeconds: Math.round((Date.parse(verification.genTime) - Date.parse(subject.referenceTime)) / 1000) }
          : {}),
      };
      return { ...base, verification, outcome: { status: 'granted', token, tokenDer: response.body } };
    },
  };
}
