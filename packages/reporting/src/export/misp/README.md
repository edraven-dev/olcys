# Dane MISP (wersje dosłowne)

Pliki pochodzą z oficjalnych repozytoriów MISP i są dołączone bez zmian (pobrane 2026-11-22):

| Plik                           | Źródło                                                                                            | Wersja |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------ |
| `coin-address.definition.json` | `https://raw.githubusercontent.com/MISP/misp-objects/main/objects/coin-address/definition.json`   | 7      |
| `estimative-language.json`     | `https://raw.githubusercontent.com/MISP/misp-taxonomies/main/estimative-language/machinetag.json` | 5      |
| `admiralty-scale.json`         | `https://raw.githubusercontent.com/MISP/misp-taxonomies/main/admiralty-scale/machinetag.json`     | 5      |
| `tlp.json`                     | `https://raw.githubusercontent.com/MISP/misp-taxonomies/main/tlp/machinetag.json`                 | 10     |

Licencja danych: CC0 1.0 lub BSD-2-Clause (do wyboru) — zob. `misp-objects.LICENSE.md`, `misp-taxonomies.LICENSE.md`
oraz `docs/compliance/licenses.md`. Eksport MISP kopiuje `template_uuid` (`d0e6997e-78da-4815-a6a1-cfc1c1cb8a46`) i
`template_version` (7) z `coin-address.definition.json` i używa wyłącznie predykatów oraz wartości z tych plików.

Odwzorowanie określeń ICD 203 (`LinkAssessment.icd203`) na `estimative-language:likelihood-probability`: „almost no
chance” → `almost-no-chance` (0), „very unlikely” → `very-unlikely` (5), „unlikely” → `unlikely` (20), „roughly even
chance” → `roughly-even-chance` (45), „likely” → `likely` (55), „very likely” → `very-likely` (80), „almost certain” →
`almost-certain` (95); liczby to `numerical_value` taksonomii (dolna granica przedziału). Pewność analityczna (`High`,
`Moderate`, `Low`) odpowiada `confidence-in-analytic-judgment` (`high`, `moderate`, `low`). Ocena wiarygodności źródła
(`admiralty-scale:source-reliability`, a–f) pochodzi z najlepszej oceny przesłanek, które się liczyły; oceny
wiarygodności informacji (`information-credibility`) OŁCyŚ nie wyznacza, więc tego tagu nie wystawia.
