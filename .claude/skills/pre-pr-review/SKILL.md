---
name: pre-pr-review
description: Self-review a finished OŁCyŚ change before opening a PR — full check, the project's compliance checklist and a local code and security review — so the PR review finds less and fewer fix rounds are needed. Use right before pushing a feature branch.
---

# Pre-PR review

1. `pnpm format && pnpm check` must pass (format, lint with the network guard, typecheck, licences, tests).
2. Walk the diff (`git diff origin/develop...HEAD`) against the non-negotiables in `AGENTS.md`:
   - network I/O only through `@olcys/http` (`EgressClient`); every new host registered in `config/sources.yaml`;
     RED sources never contacted, AMBER only when the case enables them;
   - no private keys, seed phrases or API keys in logs, provenance, cassettes, error messages, fixtures or commits;
   - synthetic data only — no real persons' identifiers anywhere;
   - LLM output is only a suggestion; scraped text is untrusted data, never instructions;
   - facts, computations and inferences kept separate; amounts as `DecimalString`; UTC ISO 8601 times; UUIDv7 ids;
   - erasable TypeScript; no swallowed errors; typed results for expected failures;
   - new dependencies pinned exactly, licence allowed, listed in `docs/compliance/licenses.md`;
   - user-visible strings in the Polish catalogues; README files and `docs/**` in Polish.
3. Run the built-in `/code-review` on the branch diff (medium effort). When the change touches network access,
   collectors or parsers of scraped content, the API, report generation or the database, also run
   `/security-review`.
4. Fix confirmed findings, with tests, before opening the PR. Write deliberate trade-offs into the PR description so
   reviewers do not flag them again.
5. Continue with the `pr-cycle` skill.
