---
name: ui-charts
description: Build charts for the OŁCyŚ web UI and report (Confidence Score waterfall, activity timeline, flow and cash-out views) following the dataviz skill and the project's constraints. Use when adding or changing any chart, graph, stat tile or legend in apps/web or in the report.
---

# Charts in the web UI and report

1. Load the built-in `dataviz` skill first and follow its method: form choice, colour formula, mark specs and
   interaction rules.
2. Project constraints:
   - No CDN, remote fonts or third-party scripts. A chart library is an npm dependency pinned exactly, with a licence
     allowed by `config/licenses.json`, recorded in `docs/compliance/licenses.md`. Prefer plain SVG and React when a
     library adds little.
   - Every label, legend, tooltip and unit comes from the Polish catalogue (`apps/web/src/i18n/pl.ts`; reports use
     the reporting package's catalogue). Format numbers and dates for `pl-PL`. Amounts are `DecimalString`: format the
     decimal string, never round through JavaScript floats.
   - Keep facts, computations and inferences visually distinct (separate panels or explicit badges).
   - Charts work in light and dark themes, at phone width, and print legibly in the PDF report.
   - Colour is never the only carrier of meaning: rejected, excluded and cash-out states also get text or an icon.
3. Typical charts:
   - Confidence Score waterfall: prior odds, each evidence contribution in log-odds bits (signed), gates, and the
     final 0–100 score with its ICD 203 term.
   - Activity timeline per address: incoming and outgoing transfers over time, PLN values at the NBP rate, cash-out
     indicators marked.
   - Flow view: subject addresses → counterparties (labelled services, deposit addresses) with exclusion reasons.
4. Develop and test with synthetic fixture data only; screenshots never show real persons.
