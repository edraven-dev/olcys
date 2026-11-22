-- Chain-of-custody events: what happened to a capture or report, when and by whom (collected, timestamped, verified,
-- included in a report, exported, viewed). Append-only for the runtime role: olcys_app may read and insert, never
-- update or delete.
SET search_path = olcys, public;

CREATE TABLE custody_event (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  at           timestamptz NOT NULL,
  actor        text NOT NULL,
  action       text NOT NULL CHECK (action IN ('collected', 'timestamped', 'timestamp_failed', 'verified',
                                               'verification_failed', 'included_in_report', 'exported', 'viewed')),
  subject_type text NOT NULL CHECK (subject_type IN ('capture', 'report', 'report_artifact')),
  subject_id   uuid NOT NULL,
  run_id       uuid REFERENCES runs (id),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custody_event_subject ON custody_event (subject_type, subject_id, at);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON custody_event TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON custody_event FROM olcys_app;
