-- Bitcoin co-spend clusters of the chain analysis (a HEURISTIC result: inputs spent together are assumed to share an
-- owner, CoinJoin-shaped and collaborative transactions are skipped). One row per run and cluster; `id` is derived from
-- the sorted member list, so the same members give the same id in every run. `previous_size` is the size of the cluster
-- of the same seed in the previous run (growth factor of rule A7). Runs as the schema owner.
--
-- Computed results are append-only for the runtime role: olcys_app may read and insert, never update or delete.
SET search_path = olcys, public;

CREATE TABLE address_cluster (
  run_id            uuid NOT NULL REFERENCES runs (id),
  id                text NOT NULL CHECK (id ~ '^c_[0-9a-f]{16}$'),
  chain             text NOT NULL,
  heuristic         text NOT NULL CHECK (heuristic IN ('co_spend')),
  algorithm_version text NOT NULL,
  seeds             text[] NOT NULL CHECK (cardinality(seeds) >= 1),
  members           text[] NOT NULL CHECK (cardinality(members) >= 1),
  size              integer NOT NULL CHECK (size >= 1),
  previous_size     integer CHECK (previous_size >= 1),
  merge_evidence    jsonb NOT NULL CHECK (jsonb_typeof(merge_evidence) = 'array'),
  skipped           jsonb NOT NULL CHECK (jsonb_typeof(skipped) = 'array'),
  service_members   jsonb NOT NULL CHECK (jsonb_typeof(service_members) = 'array'),
  flags             jsonb NOT NULL CHECK (jsonb_typeof(flags) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, id)
);

-- Seed lookups for the previous sizes of a case.
CREATE INDEX address_cluster_seeds_idx ON address_cluster USING gin (seeds);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON address_cluster TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON address_cluster FROM olcys_app;
