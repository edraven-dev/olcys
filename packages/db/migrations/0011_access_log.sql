-- Access log: who viewed or exported which case or run, why (purpose) and with what outcome. Append-only for the
-- runtime role: olcys_app may read and insert, never update, delete or truncate. No foreign keys: the log must
-- outlive and never block the records it refers to.
SET search_path = olcys, public;

CREATE TABLE access_log (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL CHECK (action IN ('case.view', 'run.view', 'evidence.view', 'report.view',
                                             'export.download', 'audit.view')),
  case_id    uuid,
  run_id     uuid,
  resource   text,
  purpose    text,
  outcome    text NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed')),
  ip         text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_log_case ON access_log (case_id, at DESC);
CREATE INDEX access_log_actor ON access_log (actor, at DESC);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON access_log TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON access_log FROM olcys_app;
