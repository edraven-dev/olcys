-- RFC 3161 trusted timestamping: every attempt to obtain a time-stamp token for a subject digest (capture manifest,
-- report PDF, report signature) and the verified tokens. Runs as the schema owner.
--
-- Both tables are append-only for the runtime role: olcys_app may read and insert, never update or delete. A request
-- never changes its status: a retry is a NEW request row, so the history of attempts (queued offline, failed, granted,
-- rejected) is kept as evidence. "Pending" is derived: a subject whose latest request is 'queued' or 'failed' and that
-- has no token. A token is unique per (subject type, subject id, digest), which makes a repeated flush idempotent.
SET search_path = olcys, public;

CREATE TABLE timestamp_request (
  id             uuid PRIMARY KEY,
  subject_type   text NOT NULL CHECK (subject_type IN ('capture_manifest', 'report_pdf', 'report_signature')),
  subject_id     uuid NOT NULL,
  digest_sha256  char(64) NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  run_id         uuid REFERENCES runs (id),
  -- The subject's own claim of existence time (capture collected_at), used for the clock cross-check on a retry.
  reference_time timestamptz,
  tsa_source_id  text NOT NULL,
  tsa_url        text NOT NULL,
  policy_oid     text,
  -- NULL for a request queued without contacting the TSA (offline, replay or disabled).
  nonce          numeric(20) CHECK (nonce > 0),
  outcome        text NOT NULL CHECK (outcome IN ('queued', 'granted', 'failed', 'rejected')),
  reason         text,
  http_status    integer,
  -- Provenance envelope of the TSA exchange (raw_fetches.id).
  fetch_id       uuid,
  at             timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timestamp_request_subject ON timestamp_request (subject_type, subject_id, digest_sha256, at DESC, id DESC);

CREATE TABLE timestamp_token (
  id             uuid PRIMARY KEY,
  subject_type   text NOT NULL CHECK (subject_type IN ('capture_manifest', 'report_pdf', 'report_signature')),
  subject_id     uuid NOT NULL,
  digest_sha256  char(64) NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  tsa_url        text NOT NULL,
  gen_time       timestamptz NOT NULL,
  serial_number  text,
  policy_oid     text,
  tsa_name       text,
  qualified      boolean NOT NULL DEFAULT false,
  skew_seconds   integer,
  -- |skew_seconds| above the threshold configured when the token was obtained (TSA_MAX_CLOCK_SKEW_SECONDS).
  skew_suspected boolean NOT NULL DEFAULT false,
  -- The whole TimeStampResp (DER) in the blob store; `openssl ts -verify` checks it independently.
  response_blob  char(64) NOT NULL CHECK (response_blob ~ '^[0-9a-f]{64}$'),
  response_bytes integer NOT NULL CHECK (response_bytes > 0),
  verification   jsonb NOT NULL,
  request_id     uuid NOT NULL REFERENCES timestamp_request (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, digest_sha256)
);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON timestamp_request, timestamp_token TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON timestamp_request, timestamp_token FROM olcys_app;
