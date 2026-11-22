/**
 * RFC 3161 requests and tokens (append-only: the application role may only insert and read). A retry is a new request
 * row; a subject is pending when its latest request is `queued` or `failed` and it has no token.
 */
import type {
  Capture,
  TimestampRepository,
  TimestampRequestRecord,
  TimestampSubject,
  TimestampToken,
  TimestampTokenRecord,
} from '@olcys/core';
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { iso, json, type Db } from '../client.ts';
import type { Database } from '../schema.ts';
import { insertCustodyEvents } from './custody.ts';

type RequestRow = Selectable<Database['timestamp_request']>;
type TokenRow = Selectable<Database['timestamp_token']>;

export const TIMESTAMP_REPLY_MEDIA_TYPE = 'application/timestamp-reply';

export function requestFromRow(r: RequestRow): TimestampRequestRecord {
  const subject: TimestampSubject = { type: r.subject_type, id: r.subject_id, digest: r.digest_sha256 };
  if (r.run_id) subject.runId = r.run_id;
  const reference = iso(r.reference_time);
  if (reference) subject.referenceTime = reference;
  const record: TimestampRequestRecord = {
    id: r.id,
    subject,
    tsaSourceId: r.tsa_source_id,
    tsaUrl: r.tsa_url,
    outcome: r.outcome,
    at: iso(r.at) ?? '',
  };
  if (r.policy_oid) record.policyOid = r.policy_oid;
  if (r.nonce !== null) record.nonce = r.nonce;
  if (r.reason) record.reason = r.reason;
  if (r.http_status !== null) record.httpStatus = r.http_status;
  if (r.fetch_id) record.fetchId = r.fetch_id;
  return record;
}

export function tokenFromRow(r: TokenRow): TimestampToken {
  return {
    tsaUrl: r.tsa_url,
    token: { sha256: r.response_blob, bytes: r.response_bytes, mediaType: TIMESTAMP_REPLY_MEDIA_TYPE },
    genTime: iso(r.gen_time) ?? '',
    hashAlgorithm: 'sha256',
    messageImprint: r.digest_sha256,
    ...(r.serial_number ? { serialNumber: r.serial_number } : {}),
    ...(r.policy_oid ? { policyOid: r.policy_oid } : {}),
    ...(r.tsa_name ? { tsaName: r.tsa_name } : {}),
    qualified: r.qualified,
    ...(r.skew_seconds !== null ? { skewSeconds: r.skew_seconds } : {}),
  };
}

/** Fills `Capture.timestamp` from the stored tokens (matched on the capture id and its manifest digest). */
export async function attachTimestamps(db: Db, captures: Capture[]): Promise<Capture[]> {
  if (captures.length === 0) return captures;
  const rows = await db
    .selectFrom('timestamp_token')
    .selectAll()
    .where('subject_type', '=', 'capture_manifest')
    .where(
      'subject_id',
      'in',
      captures.map((c) => c.id),
    )
    .execute();
  const byKey = new Map(rows.map((r) => [`${r.subject_id}:${r.digest_sha256}`, r]));
  return captures.map((capture) => {
    const row = byKey.get(`${capture.id}:${capture.manifestSha256}`);
    return row ? { ...capture, timestamp: tokenFromRow(row) } : capture;
  });
}

export function sqlTimestampRepository(db: Db): TimestampRepository {
  return {
    async record({ request, token, custody }) {
      return db.transaction().execute(async (trx) => {
        const { subject } = request;
        await trx
          .insertInto('timestamp_request')
          .values({
            id: request.id,
            subject_type: subject.type,
            subject_id: subject.id,
            digest_sha256: subject.digest,
            run_id: subject.runId ?? null,
            reference_time: subject.referenceTime ?? null,
            tsa_source_id: request.tsaSourceId,
            tsa_url: request.tsaUrl,
            policy_oid: request.policyOid ?? null,
            nonce: request.nonce ?? null,
            outcome: request.outcome,
            reason: request.reason ?? null,
            http_status: request.httpStatus ?? null,
            fetch_id: request.fetchId ?? null,
            at: request.at,
          })
          .execute();
        if (token) {
          const stored = await trx
            .insertInto('timestamp_token')
            .values({
              id: token.id,
              subject_type: subject.type,
              subject_id: subject.id,
              digest_sha256: subject.digest,
              tsa_url: token.token.tsaUrl,
              gen_time: token.token.genTime,
              serial_number: token.token.serialNumber ?? null,
              policy_oid: token.token.policyOid ?? null,
              tsa_name: token.token.tsaName ?? null,
              qualified: token.token.qualified ?? false,
              skew_seconds: token.token.skewSeconds ?? null,
              response_blob: token.token.token.sha256,
              response_bytes: token.token.token.bytes,
              verification: json(token.verification),
              request_id: request.id,
            })
            .onConflict((oc) => oc.columns(['subject_type', 'subject_id', 'digest_sha256']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (!stored) return { tokenStored: false };
        }
        await insertCustodyEvents(trx, custody ?? []);
        return { tokenStored: Boolean(token) };
      });
    },

    async getToken(subject) {
      const row = await db
        .selectFrom('timestamp_token')
        .selectAll()
        .where('subject_type', '=', subject.type)
        .where('subject_id', '=', subject.id)
        .where('digest_sha256', '=', subject.digest)
        .executeTakeFirst();
      if (!row) return undefined;
      const record: TimestampTokenRecord = {
        id: row.id,
        subject: { type: row.subject_type, id: row.subject_id, digest: row.digest_sha256 },
        requestId: row.request_id,
        token: tokenFromRow(row),
        verification: row.verification,
        createdAt: iso(row.created_at) ?? '',
      };
      return record;
    },

    async listPending(limit = 100) {
      const rows = await db
        .selectFrom('timestamp_request as r')
        .selectAll('r')
        .where('r.outcome', 'in', ['queued', 'failed'])
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('timestamp_token as t')
                .select('t.id')
                .whereRef('t.subject_type', '=', 'r.subject_type')
                .whereRef('t.subject_id', '=', 'r.subject_id')
                .whereRef('t.digest_sha256', '=', 'r.digest_sha256'),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('timestamp_request as n')
                .select('n.id')
                .whereRef('n.subject_type', '=', 'r.subject_type')
                .whereRef('n.subject_id', '=', 'r.subject_id')
                .whereRef('n.digest_sha256', '=', 'r.digest_sha256')
                .where(sql<boolean>`(n.at, n.id) > (r.at, r.id)`),
            ),
          ),
        )
        .orderBy('r.at')
        .orderBy('r.id')
        .limit(limit)
        .execute();
      return rows.map(requestFromRow);
    },

    async listRequests(subjectId) {
      const rows = await db
        .selectFrom('timestamp_request')
        .selectAll()
        .where('subject_id', '=', subjectId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map(requestFromRow);
    },
  };
}
