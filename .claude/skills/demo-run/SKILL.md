---
name: demo-run
description: Launch the OŁCyŚ stack locally and walk the synthetic demo end to end (offline mode, fixture persona, v1 → v2 re-run with change detection, report). Use to verify a change in the running app, to rehearse the demo, or to capture screenshots.
---

# Demo run

Use the built-in `run` skill to launch and drive the app; this skill adds the project specifics.

## Start

1. `cp -n .env.example .env` — defaults to `OLCYS_MODE=offline`; keep the telemetry opt-outs.
2. `pnpm install`, then `pnpm dev:deps` (PostgreSQL, Gotenberg and the fixture site in containers; ports bound to
   127.0.0.1; the fixture site answers `ok v1` on `http://127.0.0.1:4100/healthz`).
3. `pnpm db:migrate` on a fresh database (runs as the owner role).
4. Start the apps on the host **without** a second fixture site (the container already holds port 4100):
   `pnpm --parallel --filter './apps/*' --filter '!@olcys/fixture-site' run dev` — API on :4000, web UI on :5173,
   worker. To run the fixture site on the host instead (e.g. while editing it), stop its container first
   (`docker compose stop fixture-site`).

## Walk the demo (synthetic persona only)

Use only what is merged: check `README.md` and the recent history for which parts exist (persona fixtures, analysis
pipeline, API routes, UI, report). Skip steps whose feature is missing and say which ones you skipped — never present
a skipped step as verified.

1. Create a case for the persona described in `fixtures/persona/manifest.json`; its identifiers are synthetic.
2. Run the analysis and check:
   - candidate addresses with their evidence;
   - Confidence Scores matching `manifest.expected`;
   - rejected addresses (exchange deposit, labelled service, documentation vector, homoglyph) with reasons;
   - on-chain activity and cash-out indicators valued in PLN;
   - the evidence register with SHA-256 hashes.
3. Switch the fixture site to variant v2 and re-run: restart it with `FIXTURE_VARIANT=v2`, or — where the runtime
   switch exists — enable it with `FIXTURE_ALLOW_VARIANT_SWITCH=1` and send
   `curl -X POST --data v2 http://127.0.0.1:4100/__fixture/variant`.
   Check the change list: `VALUE_CHANGED` on the profile's Bitcoin address.
4. Generate the report (Polish HTML, PDF via Gotenberg) and open it.

## Rules

- `offline` mode reaches only the fixture site and internal services. `live` mode only for GREEN sources enabled in
  the case (e.g. NBP exchange rates) — never against real private persons.
- Screenshots and recordings show synthetic data only.
- Stop the dependencies with `pnpm dev:deps:down` when done.
