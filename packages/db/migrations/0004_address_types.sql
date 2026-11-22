-- Address types of the chain analysis: one classification per run and address (EOA, EIP-7702 delegated EOA, Safe,
-- ERC-4337 account, token contract, contract, UTXO script type, unknown), "as of the recorded chain tip" (state reads
-- use `latest`, so a later run may classify the same address differently). fetch_ids lists the requests behind the
-- classification (contract code first, then every probe) in call order. Runs as the schema owner.
--
-- Computed results are append-only for the runtime role: olcys_app may read and insert, never update or delete.
SET search_path = olcys, public;

CREATE TABLE address_type_classification (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id           uuid NOT NULL REFERENCES runs (id),
  chain            text NOT NULL,
  address          text NOT NULL,
  type             text NOT NULL CHECK (type IN ('eoa', 'contract', 'delegated_eoa', 'safe', 'erc4337_account',
                                                 'token_contract', 'utxo_script', 'unknown')),
  code_prefix      text,
  code_size        integer CHECK (code_size >= 0),
  delegate         text,
  safe_master_copy text,
  entry_point      text,
  implementation   text,
  script_type      text CHECK (script_type IN ('p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr', 'unknown')),
  -- A probe that failed ({ "probe": …, "message": … }): the type is the most specific the completed probes support.
  failed_probe     jsonb CHECK (failed_probe IS NULL OR jsonb_typeof(failed_probe) = 'object'),
  fetch_ids        uuid[] NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, chain, address)
);

-- Explicit, independent of the schema's default privileges.
GRANT SELECT, INSERT ON address_type_classification TO olcys_app;
REVOKE UPDATE, DELETE, TRUNCATE ON address_type_classification FROM olcys_app;
