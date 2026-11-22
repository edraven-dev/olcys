-- Periodic re-runs. Runs as the schema owner. The case's current schedule is the only new mutable value; every change
-- of it and every handled occurrence ("tick") are append-only records.
SET search_path = olcys, public;

-- Current schedule of the case: { "cron": "<five fields, UTC>", "enabled": true|false }. Unlike evidence, it is
-- configuration the analyst changes during the life of a case, so the application role may replace this one column.
-- No history is lost: every change is also written, in the same transaction, to the append-only case_schedule_change
-- log (who, why, the value before and after), which is the record of processing.
ALTER TABLE cases ADD COLUMN schedule jsonb
  CHECK (schedule IS NULL OR (jsonb_typeof(schedule -> 'cron') = 'string' AND jsonb_typeof(schedule -> 'enabled') = 'boolean'));
GRANT UPDATE (schedule) ON cases TO olcys_app;

CREATE TABLE case_schedule_change (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id    uuid NOT NULL REFERENCES cases (id),
  before     jsonb,
  after      jsonb NOT NULL,
  changed_by text NOT NULL,
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_schedule_change_case ON case_schedule_change (case_id, at DESC);

-- One row per handled occurrence. job_id ('<case id>@<occurrence>') is unique: inserting the row is the claim, so an
-- occurrence starts at most one run, also when several processes evaluate the schedules. A tick that starts a run is
-- inserted before that run in the same transaction, hence the deferred foreign key.
CREATE TABLE schedule_tick (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id       uuid NOT NULL REFERENCES cases (id),
  job_id        text NOT NULL UNIQUE,
  scheduled_for timestamptz NOT NULL,
  fired_at      timestamptz NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('started', 'skipped_overlap', 'skipped_disabled', 'skipped_case_closed')),
  run_id        uuid REFERENCES runs (id) DEFERRABLE INITIALLY DEFERRED,
  at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'started') = (run_id IS NOT NULL))
);
CREATE INDEX schedule_tick_case ON schedule_tick (case_id, scheduled_for DESC);

-- Append-only for the application role (the default privileges grant the same): read and add, never change or delete.
GRANT SELECT, INSERT ON case_schedule_change, schedule_tick TO olcys_app;
