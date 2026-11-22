/**
 * Trusted timestamping in the worker: an RFC 3161 token for every persisted capture-manifest digest. Only `live` mode
 * contacts the TSA; `offline`, `replay` and a disabled service record a `queued` request that a later live flush
 * grants (there is no job queue: the flush is a function, run by the `tsa:flush` CLI and by the scheduler's timer).
 * Every attempt is an immutable request row; a granted attempt also stores the verified token and a custody event.
 */
import { join } from 'node:path';
import type {
  Clock,
  CustodyEvent,
  FetchMode,
  Logger,
  Repositories,
  SourceDescriptor,
  TimestampOutcome,
  TimestampRequestRecord,
  TimestampSubject,
  TimestampTokenRecord,
  TrustedTimestamper,
  BlobStore,
  EgressClient,
  Id,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { redBlockedHosts } from '@olcys/collectors';
import { createRfc3161Client, loadTrustAnchors, type Rfc3161Client, type Rfc3161Config } from '@olcys/evidence';
import { createEgressClient } from '@olcys/http';
import { REPO_ROOT, TOOL_VERSION } from './config.ts';

export interface TsaSettings {
  enabled: boolean;
  url: string;
  sourceId: string;
  policyOid?: string;
  qualified: boolean;
  /** Trust anchor PEM files (absolute paths). */
  trustAnchorPaths: string[];
  timeoutMs: number;
  maxClockSkewSeconds: number;
  /** `Authorization` header value for a contracted TSA. */
  authorization?: string;
}

/** A configuration error with a stable code (`tsa_host_not_allow_listed`, `tsa_source_invalid`, `tsa_config_invalid`). */
export class TsaConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TsaConfigError';
    this.code = code;
  }
}

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new TsaConfigError('tsa_config_invalid', `${name} must be a positive whole number, got "${raw}"`);
  }
  return Number(raw);
}

export function tsaSettings(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): TsaSettings {
  const enabled = !['false', '0', 'no', 'off'].includes((env['TSA_ENABLED'] ?? 'true').trim().toLowerCase());
  const user = env['TSA_USERNAME']?.trim();
  const password = env['TSA_PASSWORD'];
  const anchors = (env['TSA_TRUST_ANCHORS']?.trim() || 'config/tsa/freetsa/cacert.pem')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const policy = env['TSA_POLICY_OID']?.trim();
  return {
    enabled,
    url: env['TSA_URL']?.trim() || 'https://freetsa.org/tsr',
    sourceId: env['TSA_SOURCE_ID']?.trim() || 'freetsa',
    ...(policy ? { policyOid: policy } : {}),
    qualified: (env['TSA_QUALIFIED'] ?? 'false').trim().toLowerCase() === 'true',
    trustAnchorPaths: anchors.map((p) => (p.startsWith('/') ? p : join(root, p))),
    timeoutMs: whole(env, 'TSA_TIMEOUT_MS', 10_000),
    maxClockSkewSeconds: whole(env, 'TSA_MAX_CLOCK_SKEW_SECONDS', 120),
    ...(user && password ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {}),
  };
}

const hostAllowed = (host: string, pattern: string): boolean => {
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
};

/** The TSA source must be a `timestamping` entry of the register and list the TSA host: checked at start-up. */
export function assertTsaAllowListed(settings: TsaSettings, sources: readonly SourceDescriptor[]): SourceDescriptor {
  const source = sources.find((s) => s.id === settings.sourceId);
  if (!source || source.kind !== 'timestamping') {
    throw new TsaConfigError('tsa_source_invalid', `TSA_SOURCE_ID "${settings.sourceId}" is not a timestamping source`);
  }
  let host: string;
  try {
    const url = new URL(settings.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
    host = url.hostname.toLowerCase();
  } catch {
    throw new TsaConfigError('tsa_config_invalid', 'TSA_URL is not an http(s) URL');
  }
  if (!source.allowedHosts.some((pattern) => hostAllowed(host, pattern))) {
    throw new TsaConfigError(
      'tsa_host_not_allow_listed',
      `${host} is not in allowedHosts of source ${source.id} in config/sources.yaml`,
    );
  }
  return source;
}

export interface FlushReport {
  /** False when nothing was attempted: not live, or the service is disabled. */
  ran: boolean;
  reason?: 'disabled' | 'not_live';
  attempted: number;
  granted: number;
  failed: number;
  rejected: number;
}

export interface WorkerTimestamper extends TrustedTimestamper {
  readonly enabled: boolean;
  /** True when a flush can reach the TSA (live mode and enabled). */
  readonly canFlush: boolean;
  /** Retries queued and failed requests; idempotent (one token per subject digest). */
  flush(options?: { limit?: number; subjectIds?: Id[] }): Promise<FlushReport>;
}

export interface TimestamperOptions {
  repos: Repositories;
  blobs: BlobStore;
  settings: TsaSettings;
  sources: readonly SourceDescriptor[];
  mode: FetchMode;
  logger: Logger;
  clock?: Clock;
  /** Injected in tests: the egress client and/or the trust anchors (PEM) instead of the files. */
  http?: EgressClient;
  anchorsPem?: string[];
  userAgent?: string;
  /** Injected in tests. */
  random?: () => bigint;
}

const CUSTODY_SUBJECT: Record<TimestampSubject['type'], CustodyEvent['subject']['type']> = {
  capture_manifest: 'capture',
  report_pdf: 'report',
  report_signature: 'report_artifact',
};

export async function createTrustedTimestamper(options: TimestamperOptions): Promise<WorkerTimestamper> {
  const { repos, blobs, settings, mode, logger } = options;
  const clock = options.clock ?? { now: () => new Date() };
  const timestamps = repos.timestamps;
  if (!timestamps) throw new Error('the repositories do not support timestamps');
  const canFlush = settings.enabled && mode === 'live';
  const actor = `tsa:${settings.sourceId}`;

  let client: Rfc3161Client | undefined;
  let http: EgressClient | undefined;
  if (settings.enabled) {
    const source = assertTsaAllowListed(settings, options.sources);
    if (mode === 'live') {
      const anchorsPem = options.anchorsPem ?? (await loadTrustAnchors(settings.trustAnchorPaths));
      const config: Rfc3161Config = {
        tsaUrl: settings.url,
        sourceId: settings.sourceId,
        qualified: settings.qualified,
        trustAnchorsPem: anchorsPem,
        timeoutMs: settings.timeoutMs,
        maxClockSkewSeconds: settings.maxClockSkewSeconds,
        ...(settings.policyOid ? { policyOid: settings.policyOid } : {}),
        ...(settings.authorization ? { authorization: settings.authorization } : {}),
      };
      client = createRfc3161Client(config, options.random);
      http =
        options.http ??
        createEgressClient({
          mode,
          enabledSources: [source],
          redHosts: redBlockedHosts(options.sources),
          blobs,
          sinks: {
            log: (entry) => repos.evidence.addEgressLog([entry]),
            provenance: (envelope) => repos.evidence.addRawFetches([envelope]),
          },
          toolVersion: TOOL_VERSION,
          userAgent: options.userAgent ?? `OLCYS/${TOOL_VERSION} (OSINT research prototype; synthetic demo)`,
          ...(options.clock ? { clock: options.clock } : {}),
        });
    }
  }

  const requestOf = (
    subject: TimestampSubject,
    outcome: TimestampRequestRecord['outcome'],
    extra: Partial<TimestampRequestRecord> = {},
  ): TimestampRequestRecord => ({
    id: newId(),
    subject,
    tsaSourceId: settings.sourceId,
    tsaUrl: settings.url,
    ...(settings.policyOid ? { policyOid: settings.policyOid } : {}),
    outcome,
    at: clock.now().toISOString(),
    ...extra,
  });

  const custodyOf = (
    subject: TimestampSubject,
    action: 'timestamped' | 'timestamp_failed',
    detail: CustodyEvent['detail'],
  ): CustodyEvent => ({
    id: newId(),
    at: clock.now().toISOString(),
    actor,
    action,
    ...(subject.runId ? { runId: subject.runId } : {}),
    subject: { type: CUSTODY_SUBJECT[subject.type], id: subject.id },
    detail: { digestSha256: subject.digest, tsaUrl: settings.url, ...detail },
  });

  async function stamp(subject: TimestampSubject): Promise<TimestampOutcome> {
    if (!settings.enabled || !client || !http) {
      const reason = settings.enabled ? 'offline' : 'disabled';
      await timestamps!.record({ request: requestOf(subject, 'queued', { reason }) });
      return { status: 'queued', reason };
    }
    const existing = await timestamps!.getToken(subject);
    if (existing) {
      return { status: 'granted', token: existing.token, tokenDer: await blobs.get(existing.token.token.sha256) };
    }
    const attempt = await client.request(subject, { http, blobs, clock, mode });
    const nonce = attempt.nonce?.toString();
    const base = {
      ...(nonce ? { nonce } : {}),
      ...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
      ...(attempt.fetchId ? { fetchId: attempt.fetchId } : {}),
    };
    const { outcome } = attempt;
    if (outcome.status === 'granted') {
      const { token } = outcome;
      const request = requestOf(subject, 'granted', base);
      const skewSuspected =
        token.skewSeconds !== undefined && Math.abs(token.skewSeconds) > settings.maxClockSkewSeconds;
      const record: TimestampTokenRecord = {
        id: newId(),
        subject,
        requestId: request.id,
        token,
        verification: attempt.verification ?? {},
        createdAt: clock.now().toISOString(),
      };
      const { tokenStored } = await timestamps!.record({
        request,
        token: record,
        custody: [
          custodyOf(subject, 'timestamped', {
            genTime: token.genTime,
            ...(token.serialNumber ? { serialNumber: token.serialNumber } : {}),
            ...(token.tsaName ? { tsaName: token.tsaName } : {}),
            qualified: token.qualified ?? false,
            tokenSha256: token.token.sha256,
            ...(token.skewSeconds !== undefined ? { skewSeconds: token.skewSeconds } : {}),
            skewSuspected,
          }),
        ],
      });
      if (skewSuspected) {
        logger.warn('TSA genTime differs from the collection time', { subjectId: subject.id, skew: token.skewSeconds });
      }
      // A concurrent flush won the race: report the stored token, not this duplicate.
      if (!tokenStored) {
        const stored = await timestamps!.getToken(subject);
        if (stored) {
          return { status: 'granted', token: stored.token, tokenDer: await blobs.get(stored.token.token.sha256) };
        }
      }
      return outcome;
    }
    const failedChecks = attempt.verification?.checks.filter((c) => !c.passed).map((c) => c.name) ?? [];
    const reason = attempt.error ?? (outcome.status === 'rejected' ? outcome.reason : 'unknown');
    const status = outcome.status === 'rejected' ? 'rejected' : 'failed';
    await timestamps!.record({
      request: requestOf(subject, status, { ...base, reason }),
      custody: [custodyOf(subject, 'timestamp_failed', { status, reason, failedChecks: failedChecks.join(',') })],
    });
    if (status === 'rejected') logger.error('TSA reply rejected', { subjectId: subject.id, reason });
    else logger.warn('TSA request failed, queued for retry', { subjectId: subject.id, reason });
    return outcome;
  }

  async function flush(flushOptions: { limit?: number; subjectIds?: Id[] } = {}): Promise<FlushReport> {
    const report: FlushReport = { ran: false, attempted: 0, granted: 0, failed: 0, rejected: 0 };
    if (!canFlush) return { ...report, reason: settings.enabled ? 'not_live' : 'disabled' };
    report.ran = true;
    const only = flushOptions.subjectIds && new Set(flushOptions.subjectIds);
    const pending = (await timestamps!.listPending(flushOptions.limit)).filter((r) => !only || only.has(r.subject.id));
    for (const request of pending) {
      report.attempted += 1;
      // Sequential on purpose: the TSA is rate limited (1 request per second).
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await stamp(request.subject);
      if (outcome.status === 'granted') report.granted += 1;
      else if (outcome.status === 'rejected') report.rejected += 1;
      else report.failed += 1;
    }
    logger.info('timestamp flush', { ...report });
    return report;
  }

  return { enabled: settings.enabled, canFlush, stamp, flush };
}
