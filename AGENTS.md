# AGENTS.md — instructions for coding agents (and humans)

You are implementing **OŁCyŚ** (_Osintowy łapacz cyfrowych śladów_), an OSINT tool for KAS (Polish National
Revenue Administration) analysts: from a subject's identifiers it finds publicly disclosed crypto addresses,
scores each identity↔address link, rejects misattributions, analyses on-chain activity including fiat cash-out
indicators, re-runs periodically with diffs, and produces an evidence-grade report. Read `docs/architecture.md`
before your first change.

## Non-negotiable rules (challenge requirements)

1. **OSINT only.** Public, lawful sources; never violate a site's terms; never log into anyone else's account;
   never use breached/leaked data; never solve CAPTCHAs, evade anti-bot measures, rotate proxies or scan hosts.
   When a source answers with a block, login wall or CAPTCHA: stop, record `blocked`/`login_wall`/`captcha`, move on.
2. **Sources are governed by `config/sources.yaml`.** RED sources are never contacted. AMBER sources only when the
   case enables them. Do not add a source without an entry (compliance status, note, ToS link, rate limit, hosts).
3. **All network I/O goes through `@olcys/http` (`EgressClient`).** No direct `fetch`/`undici`/axios/SDK network
   calls anywhere else. Every request is allow-listed, rate-limited, logged (with `containsIdentifier`) and gets a
   provenance envelope. Tests never hit the real network (use the fixture site, cassettes or fakes).
4. **No unapproved data flows or telemetry.** No analytics SDKs, no CDN/remote fonts/scripts in the web app, no
   crash reporting services. Keep telemetry opt-outs (`.env.example`) in every container/CI config you touch.
5. **Synthetic data only** in fixtures, tests, seeds and screenshots. Never commit real persons' identifiers.
   Never store, log or transmit private keys or seed phrases — redact them in memory (address-extractor).
6. **Open-source licences only**, recorded in `docs/compliance/licenses.md`. Forbidden: proprietary, BUSL, SSPL,
   RSAL, Commons Clause, any non-commercial clause (CC-BY-NC), source-available (e.g. Blockscout ≥ v11), licences
   excluding public bodies (e.g. QuestPDF). GPL/AGPL tools only as separate, unmodified services.
7. **The LLM never decides.** It may suggest (labels, normalisation, draft inferences); suggestions carry zero score
   weight until an analyst confirms. Scraped text is untrusted data, always delimited, never instructions.
8. **Facts, computations and inferences stay separate** in data, API and reports.
9. **UI, reports, READMEs and docs are Polish.** All user-visible strings live in `apps/web/src/i18n/pl.ts`
   (reports: the reporting package's Polish catalogue). Every `README.md` (root, packages, services, fixtures) and
   `docs/**` are written in Polish. Everything else — `AGENTS.md`, code, identifiers, logs, comments, commit messages and
   API fields — is English.

## Stack and conventions

- **Node.js 26** runs TypeScript directly (type stripping) — write **erasable TypeScript only**: no `enum`,
  `namespace`, parameter properties or decorators; use `as const` arrays + union types (see `@olcys/core`).
  Relative imports include the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- **TypeScript 7** (`tsc`) is used for type checking only (`noEmit`). Strict mode, `noUncheckedIndexedAccess`.
- **pnpm 12** workspaces. Internal deps: `"@olcys/<pkg>": "workspace:*"`. Packages export `./src/index.ts`.
- **oxlint** (lint, `--deny-warnings`) and **oxfmt** (format, single quotes, width 120). VS Code uses the Oxc
  extension (`.vscode/`); do not add Prettier, ESLint or Biome.
- **Vitest 5**: tests in `<package>/test/*.test.ts`; run one package with `pnpm vitest run --project @olcys/<pkg>`.
- **Network guard:** oxlint rejects `fetch`, `WebSocket`, `undici`, `axios`, `node:http` clients etc. outside
  `packages/http` (and own-API calls in `apps/web`); tests and `scripts/lib/local-fetch.ts` are exempt.
- **Licences:** `pnpm licenses:check` (part of `pnpm check`) verifies every npm dependency against `config/licenses.json`.
- **Architecture:** packages depend on `@olcys/core` contracts only; implementations are wired in `apps/worker`
  (and `apps/api`). `import/no-cycle` is an error. A **breaking** change to `@olcys/core` exports bumps
  `CORE_CONTRACTS_VERSION` and updates every user in the same change; additive changes (new types, new optional
  fields) need no bump.
- Money/amounts: `DecimalString`, never JS floats. Time: UTC ISO 8601 strings. IDs: UUIDv7.
- Errors: never swallow; return typed results for expected failures (`not_found`, `blocked`), throw for bugs.
- Python is allowed only in `services/osint-py` (Maigret, socid-extractor, pyHanko).

## Dependency policy

- Use the **newest stable release** of every dependency. Add with `pnpm add -E <pkg>` (exact pins) in the package
  that uses it. pnpm enforces supply-chain / release-age policies — **never bypass them** (no overrides, excludes or
  flags to install a younger version); take the newest version the policy allows.
- Container images and Python packages: newest stable (no pre-releases), exact tags/pins.
- Every new dependency: licence checked against rule 6 and added to `docs/compliance/licenses.md`.

## Commands

```bash
pnpm install                 # install workspace
pnpm dev:deps                # docker compose up -d --wait (postgres 19, gotenberg 9, fixture-site)
docker compose --profile osint --profile llm up -d --wait   # + Python worker, + local LLM (Ollama)
pnpm dev                     # api (:4000), worker, web (:5173), fixture-site (:4100) on the host
pnpm check                   # format:check + lint + typecheck + test — must pass before a change is done
pnpm format                  # oxfmt --write
```

Environment: copy `.env.example` to `.env`. Default `OLCYS_MODE=offline` (no network except the fixture site).

## Definition of Done

- [ ] All acceptance criteria met and verified; tests added for the new behaviour; `pnpm check` passes.
- [ ] No network access outside `@olcys/http`; new hosts added to `config/sources.yaml` with compliance notes.
- [ ] New dependencies pinned exactly and listed in `docs/compliance/licenses.md`.
- [ ] Synthetic data only; no secrets committed; telemetry stays off.
- [ ] UI strings in Polish via the catalogue; READMEs and `docs/**` (Polish) updated where behaviour changed.

## Git

Short-lived branches; commit messages `<area>: <imperative summary>` (e.g. `collectors: add Keybase adapter`).
Never commit `data/` or `.env`.
