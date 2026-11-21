# Domain notes for reviewers

## Run modes (`OLCYS_MODE`)

- `live`: requests go to the hosts allowed by the sources enabled for the case; with `OLCYS_RECORD=1` responses are
  recorded as cassettes (`fixtures/cassettes/<set>/<sourceId>/<requestHash>.json`) without secrets.
- `offline` (default): only local hosts (fixture site, Gotenberg, osint-py, local LLM) are reached live; every other
  host is served from cassettes, and a missing cassette is an error.
- `replay`: everything comes from cassettes, including the fixture site; only internal services stay live.
- No code path may reach an external host live outside `live` mode, including through redirects.

## Evidence model

- Every fetch produces a provenance envelope (source, redacted URL, timestamps, HTTP status, selected headers, SHA-256
  of the raw body, mode, tool version, egress log id) and an egress log entry (allowed, denied or failed, with
  `containsIdentifier`).
- Raw bodies are stored content-addressed by SHA-256; manifests and reports hash canonical JSON (RFC 8785).
- Stored evidence is never updated or deleted; corrections are new rows.

## Confidence Score

- A claim is `(identity, address, chain, relation)`. Two hops whose probabilities multiply:
  `P(identity-address) = P(identity-account) x P(account-address)`.
- Per hop: `W = log2(prior odds) + sum(log2(BF'))`, `BF' = rho * BF + (1 - rho)`, `P = 2^W / (1 + 2^W)`. Independent
  paths combine as `P = 1 - prod(1 - P_path)`; the score is `round(100 * P)`.
- `rho` comes from the Admiralty source-reliability grade (A 0.95 ... E 0.2; F needs an analyst grade before evidence
  counts). Only the strongest evidence of a feature family counts within a group of common origin (reposts and copies
  are not double-counted).
- Hard gates outside the arithmetic: an invalid checksum yields no claim; third-party attribution is a relation, not
  weak ownership evidence; exclusion rules A1-A8 (`config/rules/exclusion.v1.yaml`) move the claim to the rejected
  panel with a reason; LLM suggestions weigh 0 until an analyst confirms them.
- Weights are versioned in `config/scoring/weights.v1.yaml`; every assessment records `algorithmVersion`,
  `weightsVersion`, `weightsSha256` and the full list of contributions.
- Cash-out indicators B1-B7 (`config/rules/cashout.v1.yaml`) form a separate indicator. PLN values use the NBP Table A
  average rate of the last business day before the transaction; amounts are decimal strings, never floats.

## Synthetic demo data

- Personas, forum pages and chain histories are synthetic and served by `apps/fixture-site`. Demo wallets exist only
  in local sandbox chains (regtest, Anvil without forking); no real transactions are involved.
