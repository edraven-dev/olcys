-- Analyst overrides: inputs an analyst adds to the evidence of a case (a reliability grade for an observation,
-- candidate or source; a decision on a review-required candidate; an allowed evidence feature). An override changes
-- nothing until a later rescore run applies it; that run stores a new, separately versioned assessment.
--
-- Analyst judgements, overrides and link assessments are append-only for the runtime role: olcys_app may read and
-- insert, never update or delete (the computed score is never edited, a judgement is never rewritten).
SET search_path = olcys, public;

CREATE TABLE analyst_overrides (
  id            uuid PRIMARY KEY,
  case_id       uuid NOT NULL REFERENCES cases (id),
  kind          text NOT NULL CHECK (kind IN ('reliability_grade', 'review_decision', 'add_evidence')),
  target        jsonb NOT NULL,
  value         text NOT NULL,
  justification text NOT NULL,
  analyst       text NOT NULL,
  at            timestamptz NOT NULL
);
CREATE INDEX analyst_overrides_case ON analyst_overrides (case_id, at, id);
CREATE INDEX analyst_judgements_link ON analyst_judgements (link_assessment_id, at, id);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON analyst_overrides TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON analyst_overrides, analyst_judgements, link_assessments FROM olcys_app;
