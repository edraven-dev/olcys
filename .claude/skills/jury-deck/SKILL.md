---
name: jury-deck
description: Create or update the Polish jury presentation and demo-video script for the OŁCyŚ hackathon submission using the pptx skill. Use when preparing the final deck, the pitch or the video outline.
---

# Jury deck

1. Load the built-in `pptx` skill and follow it to produce a `.pptx` deck (plus a PDF export when asked). Save it
   where the user asks; default `docs/presentation/`.
2. Polish throughout: titles, bullets and speaker notes. Sources of truth: `README.md`, `docs/architecture.md`,
   `docs/compliance/`, and a rehearsed demo (`demo-run` skill) for screenshots.
3. Structure (about ten slides):
   1. problem and goal — what KAS analysts need;
   2. what OŁCyŚ does — identifiers → public traces → addresses → Confidence Score → exclusions → on-chain analysis
      → report;
   3. demo walkthrough with screenshots;
   4. the Confidence Score — two hops, likelihood ratios, example scores;
   5. rejecting misattributions — exchange deposits, labelled services, documentation vectors, homoglyphs;
   6. cash-out detection — PLN values at NBP rates;
   7. re-runs and change detection;
   8. evidence quality — provenance envelopes, SHA-256 hashes, egress log;
   9. compliance and safety — OSINT only, GREEN/AMBER/RED source register, synthetic data, no telemetry,
      open-source licences;
   10. architecture and technology, limitations and next steps.
4. Screenshots and examples use the synthetic persona only — never real people, wallets attributed to real persons,
   or case data.
5. Claim only what the MVP actually does; label planned features as next steps.
6. Video script: same storyline, 3–5 minutes, with timestamps and Polish narration.
