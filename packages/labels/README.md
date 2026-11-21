# @olcys/labels

Etykiety adresów z informacją o pochodzeniu, klasyfikacja typu adresu i reguły odrzucania błędnych przypisań
(`config/rules/exclusion.v1.yaml`). Reguły **przeklasyfikowują zamiast usuwać**: adres giełdy nigdy nie jest
przypisywany osobie (wynik 0), ale interakcja z giełdą zostaje zapisana jako przesłanka wyjścia do walut tradycyjnych.

- **Zależności:** kontrakty `@olcys/core` oraz `yaml`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/labels`.

## Zbiory etykiet i polityka licencji

- `loadLabelDataset(text, meta, { retrievedAt })` wczytuje plik `{ dataset, labels: [{ address, entity, category,
  attributes, confidence }] }` (np. `fixtures/labels/demo-curated.json`); adresy EVM zapisywane małymi literami; błąd
  wskazuje wpis i pole.
- Pochodzenie każdej etykiety: `datasetId`, `version`, `sourceType` (`por_file`, `graphsense_tagpack`, `ofac`,
  `etherscan_derived`, `curated` — w tej kolejności zaufania), `deciding`, licencja, `lastmod`, `retrievedAt`.
- `decidingAllowed`: rozstrzygać o wykluczeniu mogą tylko zbiory o licencji otwartej, domeny publicznej lub ujawnione
  przez wydawcę; zbiory pochodne Etherscan wyłącznie potwierdzają. Żądanie `deciding` dla innej licencji kończy się
  błędem `dataset_licence_refused`.
- `DEMO_CURATED_DATASET`: syntetyczny zbiór demonstracyjny (CC0-1.0, `por_file` — fikcyjni operatorzy sami ujawniają
  swoje portfele), więc może rozstrzygać regułę A1.
- `MemoryLabelLookup` (port `LabelLookup`): dokładne dopasowanie adresu kanonicznego; zapytanie `evm:unknown`
  dopasowuje etykiety z dowolnej sieci EVM; z parametrem `at` tylko etykiety ważne w danym dniu (`activeFrom`/`activeTo`,
  włącznie); kolejność: rodzaj zbioru, pewność malejąco, `lastmod` malejąco, id.

## Reguły (zaimplementowane w MVP)

| Reguła | Warunek                                                                                                                                                              | Wynik                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A8     | adres na liście `config/rules/deny-list.v1.yaml` (wektory testowe, dokumentacja, adresy spalania, główne kontrakty tokenów; wpisy EVM obowiązują w każdej sieci EVM) | `excluded`                                               |
| A1     | rozstrzygająca etykieta usługi (każda kategoria poza `personal_smart_account`, `scam`, `sanctioned_entity`)                                                          | `excluded`, identyfikatory etykiet                       |
| A2     | `eth_getCode` zwraca kod kontraktu (≠ `0x`, inny niż delegacja EIP-7702)                                                                                             | `excluded` (kontrakt nie jest majątkiem osoby)           |
| A3     | kod to delegacja EIP-7702 (`0xef0100` + 20 bajtów)                                                                                                                   | `kept`, z adresem delegata                               |
| A4     | adres przekazuje otrzymane środki na rozstrzygająco oznaczony portfel gorący giełdy (heurystyka adresu depozytowego)                                                 | `reclassified`, `CUSTODIAL_EXCHANGE`, `emitsCashOut: B1` |

**A4:** pary (wpływ → przekazanie) tego samego aktywa z `0 ≤ t_f − t_r ≤ τ` i `|a_f − a_r| ≤ α`, przy czym
κ = 1 − ½·|a_f − a_r|/α − ½·(t_f − t_r)/τ (zaokrąglenie do 6 miejsc, κ ≤ 0 odrzucane). Parametry z pliku reguł:
τ = 3200 bloków dla `evm:1`, na pozostałych łańcuchach τ = 3200 × 12 s; α = 0,01 jednostki aktywa. Decyzja zawiera
pary, κ, portfel docelowy, `kycLead` (adres opublikowany przez konto sprawy jest tropem KYC) i użyte parametry.

**Pierwszeństwo** (`effectiveOutcome`): A8 > A1 > A4 > A2 (`excluded`) > A3 > `kept`. `prescreenExclusions` (A8, A1)
działa przed pobraniem danych łańcuchowych — wykluczone adresy nie wymagają historii transakcji.

## Publiczne API

```ts
loadDenyList(yamlText) → DenyList                // match(address)
loadExclusionRules(yamlText) → ExclusionRulesConfig   // version, sha256, a1.trustOrder, a2.keepAttributable, a4 { tauBlocks, alpha }
classifyAddressType(address, code?, fetchIds?) → AddressTypeClassification
prescreenExclusions(address, deps) → ExclusionDecision[]
evaluateExclusions({ address, classification?, transfers, published }, { labels, rules, denyList, runId }) → ExclusionDecision[]
effectiveOutcome(decisions) → { outcome, decisive? }
```

Każda decyzja ma `rulesVersion` i angielskie uzasadnienie zaczynające się od identyfikatora reguły (np. `A4: …`); polskie
nazwy reguł pokazuje interfejs. Reguły A5–A7 (usługi behawioralne, CoinJoin, klastry) są poza MVP.
