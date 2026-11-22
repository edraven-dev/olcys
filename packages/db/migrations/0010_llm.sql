-- AI model calls and suggestions. Append-only for the runtime role: olcys_app may read and insert, never update or
-- delete. A suggestion's status is derived from its single decision row (at most one per suggestion), so nothing is
-- ever updated. A suggestion carries no score weight: nothing in the scoring tables references it.
SET search_path = olcys, public;

CREATE TABLE llm_call (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id           uuid REFERENCES cases (id),
  run_id            uuid REFERENCES runs (id),
  task              text NOT NULL,
  prompt_version    text NOT NULL,
  prompt_sha256     text NOT NULL,
  base_url          text NOT NULL,
  model_requested   text NOT NULL,
  model_reported    text,
  model_digest      text,
  params            jsonb NOT NULL DEFAULT '{}',
  request_sha256    text,
  request_blob      jsonb,
  input_sha256      text NOT NULL,
  input_capture_ids uuid[] NOT NULL DEFAULT '{}',
  input_source_ids  text[] NOT NULL DEFAULT '{}',
  response_blob     jsonb,
  output_json       jsonb,
  outcome           text NOT NULL CHECK (outcome IN ('ok', 'disabled', 'input_rejected', 'egress_denied', 'timeout',
                                                     'http_error', 'invalid_json', 'schema_violation')),
  error             text,
  http_status       integer,
  latency_ms        integer,
  usage             jsonb,
  fetch_id          uuid,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_call_run ON llm_call (run_id, started_at);

CREATE TABLE llm_suggestion (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id         uuid NOT NULL REFERENCES runs (id),
  task           text NOT NULL,
  target         jsonb NOT NULL DEFAULT '{}',
  label          text NOT NULL,
  rationale      text,
  output         jsonb,
  model          text NOT NULL,
  model_digest   text,
  prompt_version text NOT NULL,
  call_id        uuid NOT NULL REFERENCES llm_call (id),
  created_at     timestamptz NOT NULL
);
CREATE INDEX llm_suggestion_run ON llm_suggestion (run_id, created_at);

CREATE TABLE llm_suggestion_decision (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  suggestion_id uuid NOT NULL UNIQUE REFERENCES llm_suggestion (id),
  decision      text NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  justification text NOT NULL CHECK (char_length(justification) >= 10),
  edited_text   text,
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL
);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON llm_call, llm_suggestion, llm_suggestion_decision TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON llm_call, llm_suggestion, llm_suggestion_decision FROM olcys_app;
