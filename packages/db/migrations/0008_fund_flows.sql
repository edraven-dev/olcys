-- Fund flows of a run: the hop marker of expansion transfers, the computed flow edges and the per-address views
-- (timeline and Sankey aggregate). Runs as the schema owner.
--
-- Computed results are append-only for the runtime role: olcys_app may read and insert, never update or delete.
SET search_path = olcys, public;

-- 0 = history of an analysed address; n >= 1 = transfers of a counterparty fetched by hop n of the flow expansion.
-- Expansion transfers only serve flow queries; the transfer listing of a run shows hop 0 only.
ALTER TABLE chain_transfers
  ADD COLUMN expansion_hop smallint NOT NULL DEFAULT 0 CHECK (expansion_hop >= 0);

-- A flow query reads the transfers of one run and chain.
CREATE INDEX chain_transfers_flow ON chain_transfers (run_id, chain);

-- Edges of the fund-flow graph (a COMPUTED result). `hop`: downstream 1..N, upstream -1..-N. `idx` is the log or trace
-- index of the transfer (-1 when it has none). The full edge, with its PLN valuation, is kept in `record`.
CREATE TABLE flow_edge (
  run_id       uuid NOT NULL REFERENCES runs (id),
  chain        text NOT NULL,
  tx_hash      text NOT NULL,
  idx          integer NOT NULL DEFAULT -1,
  from_address text NOT NULL,
  to_address   text NOT NULL,
  asset        text NOT NULL,
  amount       numeric NOT NULL,
  at           timestamptz NOT NULL,
  hop          integer NOT NULL CHECK (hop <> 0),
  is_cycle     boolean NOT NULL DEFAULT false,
  record       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, chain, tx_hash, idx, from_address, to_address, asset, hop)
);
CREATE INDEX flow_edge_run_at ON flow_edge (run_id, at);

-- Timeline and Sankey aggregate of one analysed address (a COMPUTED result); `truncated`: the edge limit cut the graph.
CREATE TABLE fund_flow_view (
  run_id      uuid NOT NULL REFERENCES runs (id),
  chain       text NOT NULL,
  address     text NOT NULL,
  record      jsonb NOT NULL,
  truncated   boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, chain, address)
);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON flow_edge, fund_flow_view TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON flow_edge, fund_flow_view FROM olcys_app;
