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
- Analyst judgements (`same` / `not_same` / `unsure`) are stored next to an assessment and never change it (no score,
  gate, band or diff change, no rescoring). Analyst overrides (A-E grade, decision on a review-required candidate, one
  of `ADD_EVIDENCE_FEATURES`) take effect only in a rescore run, which records them in `rulesVersions.overrides`.
  `link_assessments`, `analyst_judgements` and `analyst_overrides` are append-only; the analyst comes from server
  configuration, never from the request.
- Cash-out indicators B1-B7 (`config/rules/cashout.v1.yaml`) form a separate indicator. PLN values use the NBP Table A
  average rate of the last business day before the transaction; amounts are decimal strings, never floats.

## Periodic re-runs

- A case schedule is a five-field cron expression in UTC (no macros, seconds, `H` or RRULE). The scheduler runs in the
  API process (MVP) and derives all state from the database: no external scheduler, no in-memory queue.
- Each handled occurrence is one append-only `schedule_tick` row with the unique job id `<caseId>@<occurrence>`; the
  insert is the claim, so an occurrence starts at most one run, also across processes (per-case advisory lock).
- No overlapping runs of a case (`skipped_overlap`); after downtime at most one catch-up run, for the latest missed
  occurrence. In `live` mode occurrences keep `OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES` apart; schedules never enable
  sources. The author of a schedule change comes from server configuration, never from the request.

## Synthetic demo data

- Personas, forum pages and chain histories are synthetic and served by `apps/fixture-site`. Demo wallets exist only
  in local sandbox chains (regtest, Anvil without forking); no real transactions are involved.
