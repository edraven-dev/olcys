# @olcys/labels

Etykiety adresów z informacją o pochodzeniu, klasyfikacja typu adresu i reguły odrzucania błędnych przypisań
(`config/rules/exclusion.v1.yaml`). Reguły **przeklasyfikowują zamiast usuwać**: adres giełdy nigdy nie jest
przypisywany osobie (wynik 0), ale interakcja z giełdą zostaje zapisana jako przesłanka wyjścia do walut tradycyjnych.

- **Zależności:** kontrakty `@olcys/core`, `yaml`, `@safe-global/safe-deployments` (adresy kontraktów bazowych Safe)
  i `@scure/base` (bech32/base58check). Inne pakiety są dostępne przez porty łączone w `apps/worker`.
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

## Klasyfikacja typu adresu

`classifyAddress(address, deps, ctx)` przypisuje adresowi typ (`AddressType`) na podstawie deterministycznych
odczytów stanu łańcucha. **Pułapka EIP-7702:** od aktualizacji Pectra (7 maja 2025) reguła „jest kod ⇒ kontrakt ⇒ nie
osoba” jest błędna — konto EOA z delegacją EIP-7702 zwraca 23 bajty kodu (`0xef0100` ‖ adres delegata), a nadal
steruje nim klucz prywatny osoby. Również konta Safe i konta ERC-4337 bywają prywatnymi portfelami (np. karty
płatnicze na łańcuchu), więc sam kod nie wyklucza adresu.

Procedura dla EVM (pierwsze dopasowanie kończy klasyfikację; identyfikator każdego zapytania trafia do `fetchIds`
w kolejności wykonania):

1. `getCode` zwraca `0x` → `eoa` (jedno zapytanie). Delegacja na adres zerowy czyści kod, więc konto wraca do `eoa`.
2. Dokładnie 23 bajty zaczynające się od `ef 01 00` → `delegated_eoa`, `delegate` = bajty 3…22 (małe litery),
   `codePrefix: '0xef0100'`, `codeSize: 23`, bez dalszych sond. Kod `0xef0100…` innej długości → `unknown`
   (EIP-3541 zabrania kontraktów zaczynających się od `0xef` — zapis uszkodzony).
3. Kod kontraktu (`codePrefix` = pierwsze 4 bajty, `codeSize`). Kontrakt tokena znany lokalnie (etykieta
   `token_contract` lub rejestr aktywów) → `token_contract` bez sond; w przeciwnym razie:
   1. **Safe:** `getStorageAt(adres, '0x0')` — SafeProxy trzyma kontrakt bazowy (singleton) w slocie 0; niskie 20 bajtów
      (górne 12 zerowe) należą do singletonów tej sieci → `safe` z `safeMasterCopy`. Safe z modułem ERC-4337 jest
      rozpoznawany tutaj.
   2. **ERC-4337:** `call(adres, entryPoint() = 0xb0d691fe)` zwraca słowo 32-bajtowe ze znanym EntryPoint →
      `erc4337_account` z `entryPoint`.
   3. **Token:** `totalSupply()` (`0x18160ddd`) zwraca 32 bajty, a `decimals()` (`0x313ce567`) wartość ≤ 255 →
      `token_contract`.
   4. W pozostałych przypadkach `contract`; niezerowy slot ERC-1967
      (`0x360894a1…382bbc` = keccak-256("eip1967.proxy.implementation") − 1) zapisuje `implementation` (informacyjnie).

Wycofane wywołanie (`revert`) to negatywny wynik sondy, nie błąd; dostawca bez `getStorageAt`/`call` pomija te sondy
(adres z kodem zostaje wtedy `contract`). Oczekiwane awarie dostawcy (blokada, limit zapytań) nie przerywają analizy:
nieudana sonda trafia do `failedProbe`, a typ jest najdokładniejszym, jaki uzasadniają wykonane sondy — po nieudanym
odczycie kodu albo sondzie Safe/ERC-4337 `unknown` (nie da się wykluczyć konta osoby), po nieudanej sondzie tokena
`contract`. Wszystkie sondy idą przez dostawcę skonfigurowanego dla przebiegu (klient ruchu wychodzącego, dziennik,
`containsIdentifier: true`); stan odczytywany jest z `latest`, więc typ obowiązuje „na zapisany szczyt łańcucha”
i późniejszy przebieg może go zmienić.

- **Bitcoin:** lokalnie, bez zapytań (`utxoScriptType`): bech32 v0 z programem 20/32 bajty → `p2wpkh`/`p2wsh`,
  bech32m v1 z programem 32 bajty → `p2tr`, base58check 0x00 → `p2pkh`, 0x05 → `p2sh`; typ `utxo_script`
  z `scriptType`. Inne kodowanie lub błędna suma kontrolna → `unknown`.
- **TRON:** kod z `wallet/getcontract` — `0x` → `eoa`, w przeciwnym razie kontrakt tokena (etykieta/rejestr) albo
  `contract`; TRON nie ma sond slotów ani wywołań.
- **Inne łańcuchy** → `unknown` (wykrywanie programów i mintów Solany poza MVP).
- **Ograniczenie:** konto inteligentne jeszcze niewdrożone (adres kontrfaktyczny) nie ma kodu i wygląda jak `eoa`
  do czasu wdrożenia.

Dane referencyjne (tylko publiczne adresy kontraktów ze źródłami):

- `loadSafeSingletons()` — singletony Safe z `@safe-global/safe-deployments` (MIT): wszystkie wydane wersje
  (`SAFE_VERSIONS`: 1.0.0 … 1.5.0), Safe i SafeL2, wszystkie typy wdrożeń, dla każdej sieci (`evm:<chainId>`).
- `config/labels/erc4337-entrypoints.v1.yaml` (`loadEntryPoints`) — EntryPoint v0.6, v0.7, v0.8, v0.9 z notatkami
  wydań eth-infinitism (tylko dane; kod implementacji referencyjnej nie jest używany).
- `config/labels/eip7702-delegates.v1.yaml` (`loadDelegateRegistry`, `findDelegate`) — delegaci EIP-7702
  `{ chain, address, kind: wallet_implementation | sweeper, name, source }`; wpis na `evm:unknown` obowiązuje w każdej
  sieci EVM. Rzeczywisty delegat trafia do rejestru wyłącznie z adresem URL źródła pierwotnego (otwartej, ocenionej
  listy jeszcze nie ma); obecnie rejestr zawiera tylko syntetyczny `SWEEPER-1` do demonstracji.
- Selektory i sloty (`SELECTORS`, `SAFE_SINGLETON_SLOT`, `ERC1967_IMPLEMENTATION_SLOT`) są wpisane w kod i sprawdzane
  w teście przez keccak-256 sygnatur.

## Reguły (zaimplementowane w MVP)

| Reguła | Warunek                                                                                                                                                              | Wynik                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A8     | adres na liście `config/rules/deny-list.v1.yaml` (wektory testowe, dokumentacja, adresy spalania, główne kontrakty tokenów; wpisy EVM obowiązują w każdej sieci EVM) | `excluded`                                                 |
| A1     | rozstrzygająca etykieta usługi (każda kategoria poza `personal_smart_account`, `scam`, `sanctioned_entity`)                                                          | `excluded`, identyfikatory etykiet                         |
| A2     | typ `contract` lub `token_contract` (kod kontraktu, który nie jest kontem Safe, kontem ERC-4337 ani delegacją EIP-7702)                                              | `excluded` (kontrakt nie jest majątkiem osoby)             |
| A2     | typ z `keepAttributable` (`safe`, `erc4337_account`) — prywatne konto inteligentne                                                                                   | `kept`, z kontraktem bazowym lub EntryPoint w uzasadnieniu |
| A3     | typ `delegated_eoa` (kod to delegacja EIP-7702: `0xef0100` + 20 bajtów)                                                                                              | `kept`, z adresem delegata, gdy `recordDelegate`           |
| A3     | delegat z rejestru oznaczony jako `sweeper` (`flagKnownSweepers`) — konto prawdopodobnie przejęte                                                                    | `flagged` (ostrzeżenie, adres nie jest odrzucany)          |
| A4     | adres przekazuje otrzymane środki na rozstrzygająco oznaczony portfel gorący giełdy (heurystyka adresu depozytowego)                                                 | `reclassified`, `CUSTODIAL_EXCHANGE`, `emitsCashOut: B1`   |

**A4:** pary (wpływ → przekazanie) tego samego aktywa z `0 ≤ t_f − t_r ≤ τ` i `|a_f − a_r| ≤ α`, przy czym
κ = 1 − ½·|a_f − a_r|/α − ½·(t_f − t_r)/τ (zaokrąglenie do 6 miejsc, κ ≤ 0 odrzucane). Parametry z pliku reguł:
τ = 3200 bloków dla `evm:1`, na pozostałych łańcuchach τ = 3200 × 12 s; α = 0,01 jednostki aktywa. Decyzja zawiera
pary, κ, portfel docelowy, `kycLead` (adres opublikowany przez konto sprawy jest tropem KYC) i użyte parametry.

**Pierwszeństwo** (`effectiveOutcome`): A8 > A1 > A4 > A2 (`excluded`) > A3 (`flagged`) > `kept`. `prescreenExclusions`
(A8, A1) działa przed pobraniem danych łańcuchowych — wykluczone adresy nie wymagają historii transakcji ani sond typu
adresu. A2/A3 korzystają z klasyfikacji adresu, na którym pobrano dane (dla kandydata `evm:unknown` — z jawnie wskazanej
sieci); decyzje A2–A4 takiego kandydata zapisują tę sieć w polu `resolved`. Dowody decyzji A2/A3: `fetchIds` zapytań klasyfikacji, `codePrefix`, `codeBytes`, a dla A3 `delegate`
i `delegateInfo` (wpis rejestru delegatów).

## Publiczne API

```ts
loadDenyList(yamlText) → DenyList                // match(address)
loadExclusionRules(yamlText) → ExclusionRulesConfig   // version, sha256, a1.trustOrder, a2.keepAttributable,
                                                      // a3 { recordDelegate, flagKnownSweepers }, a4 { tauBlocks, alpha },
                                                      // a6 { wasabiMinEqualOutputs, whirlpool, … }, a7 { maxClusterSize, minGrowthFactor }
classifyAddress(address, { provider?, labels, assets?, safeSingletons, entryPoints, code? }, ctx) → AddressTypeClassification
parseDelegation(code) → { delegate } | 'malformed' | undefined
utxoScriptType(address) → 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown'
loadSafeSingletons() → ReadonlyMap<ChainId, ReadonlySet<string>>
loadEntryPoints(yamlText) → ReadonlySet<string>
loadDelegateRegistry(yamlText) → ReadonlyMap<string, DelegateInfo>   // findDelegate(registry, chain, delegate)
prescreenExclusions(address, deps) → ExclusionDecision[]
evaluateExclusions({ address, classification?, resolved?, transfers, published }, { labels, rules, denyList, runId, delegates? }) → ExclusionDecision[]
effectiveOutcome(decisions) → { outcome, decisive? }
```

Każda decyzja ma `rulesVersion` i angielskie uzasadnienie zaczynające się od identyfikatora reguły (np. `A4: …`); polskie
nazwy reguł pokazuje interfejs. Reguły A5 (usługi behawioralne) i A6 jako samodzielna decyzja są poza MVP; A6 działa
jako bezpiecznik klastrowania (poniżej), A7 jest oceniana z klastrów.

## Klastrowanie Bitcoin metodą wspólnego wydatkowania (heurystyka)

`buildCoSpendClusters(seeds, txs, { labels, prevTxs, rules, maxClusterSize?, previousSizes? }, runId)` łączy adresy
wejść jednej transakcji (struktura zbiorów rozłącznych) z ziaren — adresów Bitcoin sprawy. To **heurystyka**: wynik jest
obliczeniem, nie faktem, i nie zmienia Wskaźnika Pewności. Metodykę i ograniczenia opisuje
[klastrowanie wspólnego wydatkowania](../../docs/methodology/klastrowanie-wspolwydatkowania.md).

- Bezpieczniki (`coSpendGuard`, `detectCoinJoin`): Wasabi (≥ 11 równych wyjść), Whirlpool 5×5 z tx0 lub miksu
  (nominały pul i próg opłaty w A6), ogólny wzorzec równych wyjść (≥ 3 wyjścia, ≥ 50 %), transakcja wspólna
  (P2WSH lub `OP_CHECKMULTISIG` przy ≥ 2 adresach). Pominięte transakcje trafiają do `skipped` z powodem.
- Bezpiecznik zapadania: usługa z etykietą rozstrzygającą wydana razem z adresem osoby nie dołącza do klastra
  (`serviceMembers`, `flags.serviceMerge`); limit rozmiaru (`maxClusterSize`, domyślnie `a7.maxClusterSize` = 1000) daje
  `flags.capped` i `cap_reached`; `flags.growthFactor` = rozmiar / `previousSize`.
- Bez heurystyki adresu reszty. Identyfikator `c_…` i kolejność adresów zależą tylko od zbioru adresów.
- `planClusterExpansion(clusters, fetched, { maxDepth, round, maxAddresses, exclude })` wskazuje partnerów do pobrania
  (≤ 200 adresów, głębokość ≤ 2, bez usług i adresów z listy wykluczeń); pobieranie wykonuje etap analizy łańcucha.
- `toClusterSummary(cluster)` i `evaluateClusterCollapse(summary, { rules, runId })` — reguła A7: decyzja `flagged`
  dla każdego ziarna klastra, który wchłonął usługę, osiągnął limit lub urósł co najmniej `a7.minGrowthFactor` razy.
