-- Evidence store. Runs as the schema owner. Default privileges (infra/postgres/init/01-roles.sh) give the runtime
-- role olcys_app SELECT and INSERT only: evidence is append-only. Mutable columns are granted explicitly below.
SET search_path = olcys, public;

CREATE TABLE cases (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  title       text NOT NULL,
  purpose     text NOT NULL,
  legal_basis text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  scope       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL
);

CREATE TABLE case_identifiers (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id   uuid NOT NULL REFERENCES cases (id),
  kind      text NOT NULL CHECK (kind IN ('full_name', 'nickname', 'messenger_id', 'social_login', 'email', 'crypto_address')),
  value     text NOT NULL,
  platform  text,
  chain     text,
  is_anchor boolean NOT NULL DEFAULT false,
  added_at  timestamptz NOT NULL DEFAULT now(),
  added_by  text NOT NULL
);
CREATE INDEX case_identifiers_case ON case_identifiers (case_id);

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id         uuid NOT NULL REFERENCES cases (id),
  previous_run_id uuid REFERENCES runs (id),
  trigger         text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'rescore')),
  mode            text NOT NULL CHECK (mode IN ('live', 'replay', 'offline')),
  status          text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  config          jsonb NOT NULL,
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX runs_case ON runs (case_id, queued_at DESC);

CREATE TABLE egress_log (
  id     uuid PRIMARY KEY,
  run_id uuid REFERENCES runs (id),
  at     timestamptz NOT NULL,
  entry  jsonb NOT NULL
);
CREATE INDEX egress_log_run ON egress_log (run_id, at);

CREATE TABLE raw_fetches (
  id          uuid PRIMARY KEY,
  run_id      uuid REFERENCES runs (id),
  received_at timestamptz NOT NULL,
  envelope    jsonb NOT NULL
);
CREATE INDEX raw_fetches_run ON raw_fetches (run_id);

CREATE TABLE captures (
  id              uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES runs (id),
  source_id       text NOT NULL,
  url             text NOT NULL,
  final_url       text NOT NULL,
  status          text NOT NULL,
  collected_at    timestamptz NOT NULL,
  manifest_sha256 text NOT NULL,
  record          jsonb NOT NULL
);
CREATE INDEX captures_run ON captures (run_id);

CREATE TABLE accounts (
  id       uuid PRIMARY KEY,
  run_id   uuid NOT NULL REFERENCES runs (id),
  platform text NOT NULL,
  handle   text NOT NULL,
  record   jsonb NOT NULL
);
CREATE INDEX accounts_run ON accounts (run_id);

CREATE TABLE observations (
  id           uuid PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES runs (id),
  capture_id   uuid NOT NULL REFERENCES captures (id),
  source_id    text NOT NULL,
  subject_type text NOT NULL,
  subject_key  text NOT NULL,
  property     text NOT NULL,
  value        text NOT NULL,
  locator      text NOT NULL,
  observed_at  timestamptz NOT NULL
);
CREATE INDEX observations_diff ON observations (run_id, subject_type, subject_key, property, locator);

CREATE TABLE extraction_results (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  capture_id uuid NOT NULL REFERENCES captures (id),
  record     jsonb NOT NULL
);

CREATE TABLE address_candidates (
  id         uuid PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs (id),
  capture_id uuid NOT NULL REFERENCES captures (id),
  chain      text NOT NULL,
  address    text NOT NULL,
  record     jsonb NOT NULL
);
CREATE INDEX address_candidates_run ON address_candidates (run_id, chain, address);

-- A detected private key / seed phrase: kind and position only. There is deliberately no column for the secret.
CREATE TABLE secret_findings (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id     uuid NOT NULL REFERENCES runs (id),
  capture_id uuid NOT NULL REFERENCES captures (id),
  kind       text NOT NULL,
  view       text NOT NULL,
  span_start integer NOT NULL,
  span_end   integer NOT NULL
);

CREATE TABLE chain_transfers (
  id      uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id  uuid NOT NULL REFERENCES runs (id),
  chain   text NOT NULL,
  address text NOT NULL,
  tx_hash text NOT NULL,
  record  jsonb NOT NULL
);
CREATE INDEX chain_transfers_run ON chain_transfers (run_id, chain, address);

CREATE TABLE address_labels (
  id       uuid PRIMARY KEY DEFAULT uuidv7(),
  chain    text NOT NULL,
  address  text NOT NULL,
  entity   text NOT NULL,
  category text NOT NULL,
  dataset  text NOT NULL,
  record   jsonb NOT NULL,
  UNIQUE (chain, address, entity, dataset)
);

CREATE TABLE exclusion_decisions (
  id      uuid PRIMARY KEY,
  run_id  uuid NOT NULL REFERENCES runs (id),
  chain   text NOT NULL,
  address text NOT NULL,
  rule_id text NOT NULL,
  outcome text NOT NULL,
  record  jsonb NOT NULL
);

CREATE TABLE activity (
  id      uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id  uuid NOT NULL REFERENCES runs (id),
  chain   text NOT NULL,
  address text NOT NULL,
  record  jsonb NOT NULL
);

CREATE TABLE cash_out_events (
  id      uuid PRIMARY KEY,
  run_id  uuid NOT NULL REFERENCES runs (id),
  chain   text NOT NULL,
  address text NOT NULL,
  rule_id text NOT NULL,
  record  jsonb NOT NULL
);

CREATE TABLE link_assessments (
  id          uuid PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs (id),
  identity_id uuid NOT NULL REFERENCES case_identifiers (id),
  chain       text NOT NULL,
  address     text NOT NULL,
  relation    text NOT NULL,
  tier        text NOT NULL,
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  record      jsonb NOT NULL
);
CREATE INDEX link_assessments_run ON link_assessments (run_id, score DESC);

CREATE TABLE analyst_judgements (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  link_assessment_id uuid NOT NULL REFERENCES link_assessments (id),
  judgement          text NOT NULL CHECK (judgement IN ('same', 'not_same', 'unsure')),
  justification      text NOT NULL,
  analyst            text NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE change_events (
  id              uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES runs (id),
  previous_run_id uuid NOT NULL REFERENCES runs (id),
  kind            text NOT NULL,
  record          jsonb NOT NULL
);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id      uuid NOT NULL REFERENCES runs (id),
  kind        text NOT NULL,
  blob_sha256 text NOT NULL,
  media_type  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only mutable state: run lifecycle and case status.
GRANT UPDATE (status, progress, error, started_at, finished_at) ON runs TO olcys_app;
GRANT UPDATE (status) ON cases TO olcys_app;
