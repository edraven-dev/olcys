# @olcys/analytics

Wycena w PLN (kursy NBP), wskaźniki aktywności, wymiany na DEX i konwersje na stablecoiny, przesłanki wyjścia do walut
tradycyjnych (B1, B4, B5) z osobnym wynikiem oraz przepływy środków do chronologicznej narracji raportu. Wyniki są
obliczeniami dotyczącymi adresów, nigdy stwierdzeniami o osobie.

- **Zależności:** kontrakty `@olcys/core` oraz `yaml`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/analytics` (kursy NBP i ceny
  w testach są syntetyczne).

## Wycena (reguła PIT, art. 11a ustawy o PIT)

- Kurs średni NBP z tabeli A z **ostatniego dnia roboczego przed dniem transakcji**; dzień to data kalendarzowa
  w strefie Europe/Warsaw (`2026-11-12T23:30Z` to w Polsce 13 listopada). Wybierana jest najnowsza tabela sprzed tego
  dnia (najwyżej 10 dni wstecz) — w święta NBP nie publikuje tabel, więc kalendarz świąt nie jest potrzebny.
- API NBP (GREEN, bez klucza, ujawnia tylko daty i waluty): `GET https://api.nbp.pl/api/exchangerates/rates/a/{kod}/
  {RRRR-MM-01}/{koniec miesiąca}/?format=json` — jedno zapytanie na miesiąc i walutę (stałe adresy, więc nagrane kasety
  pasują do kolejnych przebiegów); 404 „Brak danych” oznacza pusty miesiąc. Kurs zapisywany dokładnie jak w źródle
  (`3.6500`) z numerem tabeli. Źródło kursów może dostać własnego klienta ruchu wychodzącego (`http`), np. by pobierać
  NBP na żywo, gdy dane łańcuchowe pochodzą ze strony testowej.
- `pln = zaokrąglenie(kwota × cena × kurs, 2)` metodą „połówkowo w górę”, raz na końcu; bez liczb zmiennoprzecinkowych.
- **Ceny kryptoaktywów:** nigdy z API cenowego dla pojedynczych transakcji. Demonstracja używa syntetycznego zbioru
  `fixtures/prices/demo-prices.v1.json` (miesięczne wartości BTC/USD i ETH/USD, oznaczone jako syntetyczne; w rodowodzie
  wyceny `price.source = 'synthetic'` i SHA-256 pliku). Wdrożenie produkcyjne importuje licencjonowane archiwa świec
  (Kraken OHLCVT po weryfikacji prawnej; Binance Vision odrzucone — CC-BY-NC-SA).
- **Stablecoiny USD** (USDT, USDC według kontraktu): jawne założenie parytetu 1:1 widoczne w rodowodzie
  (`peg-assumption`, `USDT/USD`, `1`), potem kurs NBP USD. Tokeny spoza rejestru aktywów nie są wyceniane.

## Wskaźniki aktywności (`activity.v1`)

- `txCount` — liczba różnych transakcji; `volumeIn`/`volumeOut` — suma aktywa natywnego, rozbicie `byAsset`
  (`ETH`, `USDT` albo `SYMBOL:kontrakt` dla nieznanych tokenów), suma PLN wycenionych nóg (każda po swoim kursie) i liczba
  nóg bez wyceny (`unpriced`). Bitcoin: saldo netto na transakcję (reszta wraca na adres, więc nie jest wolumenem; opłata
  jest w wypływie).
- `counterpartyCount` — różne adresy po drugiej stronie; `serviceInteractions` — interakcje z usługami według kategorii,
  podmiotu i kierunku (etykieta, decyzja A4 lub adres depozytowy rozpoznany po przekazaniu środków na portfel giełdy).
- `swaps` — wymiana w jednej transakcji (aktywo A wychodzi, B wchodzi) potwierdzona etykietą DEX lub nazwą metody, albo
  wpływ z oznaczonej puli DEX (`dex_inflow`, strona sprzedaży niewidoczna); `stablecoinConversionPln` — suma wymian na
  stablecoiny.

## Przesłanki wyjścia do walut tradycyjnych (`cashout.v1`) i wynik (`cashout-score.v1`)

| Reguła | Siła        | Warunek (zaimplementowany w MVP)                                                                                                                                                                                                       |
| ------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1     | silna       | adres jest adresem depozytowym (A4) — zdarzenie na każdy depozyt; albo przelew na adres depozytowy giełdy (decyzja A4 lub przekazanie na portfel giełdy widoczne w danych kontrahenta); albo przelew na portfel giełdy z `fiatCapable` |
| B4     | silna/słaba | wymiana na stablecoin, a w ciągu 14 dni wyjścia B1 tego samego aktywa ≥ 50 % kwoty; bez takiego wyjścia — słaba                                                                                                                        |
| B5     | średnia     | ≥ 5 przelewów stablecoina w okrągłych kwotach (≥ 100, wielokrotność 100) do ≥ 5 różnych nieoznaczonych adresów w ciągu 30 dni (wzorzec P2P; noga fiat poza łańcuchem — wymaga potwierdzenia)                                           |

Wynik: zdarzenia grupowane według kontrahenta (podmiot, inaczej adres), waga grupy = max(waga(siła) × 0,5^przeskoki),
wynik = round(100 × (1 − Π(1 − w))). Wagi nieskalibrowane: silna 0,6, średnia 0,3, słaba 0,1, flaga 0. Wynik jest
oddzielny od Confidence Score powiązania. Reguły B2, B3, B6, B7 są poza MVP.

## Przepływy środków

`buildFundFlow` zwraca krawędzie `FlowEdge` (`hop` 1 — wypływ z analizowanego adresu, −1 — wpływ, 2 — przekazanie z adresu
depozytowego na portfel giełdy) z wyceną oraz chronologiczną oś (`FlowTimelineEntry`: przelew, wymiana, przesłanka)
dla narracji raportu. `planCounterpartyExpansion` wskazuje nieoznaczonych odbiorców do jednego dodatkowego pobrania.

### Graf przepływów do N skoków

Przepływy są wynikami obliczeń (sekcja B), nie faktami. Pakiet składa je z czterech funkcji; samo wyszukiwanie ścieżek
leży w `queryFlowEdges` (`@olcys/db`) i `traceFlows` (`@olcys/core`, magazyn w pamięci) — oba mają tę samą semantykę.

- **Znak skoku (`FlowEdge.hop`).** W dół (dokąd poszły środki): `1…N`, krawędź wychodząca z analizowanego adresu ma
  `1`. W górę (skąd pochodziły środki): `−1…−N`, krawędź wchodząca do analizowanego adresu ma `−1`. Głębokość grafu to
  `maxHops` z `config/rules/cashout.v1.yaml` (3).
- **Ścieżki.** Ścieżka w dół kontynuuje transfery wychodzące z poprzedniego odbiorcy nie starsze niż poprzedni transfer
  (monotoniczność czasu); ścieżka w górę — nie nowsze. Ścieżka kończy się na adresie z etykietą usługi lub
  z decyzją o wykluczeniu (krawędź do niego jest pokazana, ale dalej się jej nie śledzi) oraz na ponownie osiągniętym
  adresie analizowanym (pokazanym, niekontynuowanym). Adres powtórzony na ścieżce zamyka cykl: krawędź ma
  `isCycle: true` i nie jest kontynuowana. Każdy transfer występuje raz, z najmniejszym |hop|. Wynik jest ograniczony
  limitem krawędzi (2 000); przekroczenie ustawia `truncated`.
- **`buildFlowEdges(wiersze, { valuator, assets }, ctx)`** — krawędzie wyceniane w PLN po kursie NBP z dnia transferu
  (reguła PIT). Noga bez wyceny (nieznany token, brak ceny lub kursu) zostaje bez pola `valuation` — jest nieocenioną,
  nigdy zerem.
- **`buildTimeline(krawędzie, wymiany, zdarzenia, { maxHop?, counterparty? })`** — oś chronologiczna: przelewy (domyślnie
  skok ±1), wymiany i przesłanki wyjścia do fiat. Przy równych czasach kolejność jest stała: przelew, wymiana,
  przesłanka, potem reguła, hash transakcji, indeks, nadawca, odbiorca.
- **`buildSankey(krawędzie, ziarna, etykiety, { maxLinks? })`** — agregat warstwowy bez cykli. Węzeł to adres w warstwie
  (`${chain}:${adres}#${warstwa}`): skok `h > 0` prowadzi z warstwy `h − 1` do `h`, skok `h < 0` z warstwy `h` do `h + 1`,
  więc każde łącze idzie z warstwy `k` do `k + 1` (wykres Sankey wymaga grafu acyklicznego). Krawędzie cykliczne
  i pętle własne są pomijane. Łącze sumuje kwoty per aktywo i PLN z wycenionych nóg; `plnComplete: false`, gdy
  którakolwiek noga jest bez wyceny. Zostaje 50 łączy o największej wartości PLN; reszta trafia do jednego węzła
  „pozostałe” (`isOther`) na warstwę.
- **`planHopExpansion(front, { isService, isExcluded, fetched, txCount }, { perHop: 25, maxTxCount: 1000 })`** — kogo
  pobrać w kolejnym skoku: najpierw odbiorcy, potem nadawcy, każda grupa malejąco wg wartości PLN (bez wyceny na końcu);
  pomija usługi, adresy wykluczone i już pobrane; najwyżej 25 na skok. Adres z `txCount` ≥ 1000 dostaje
  `want.transfers: false` (tylko podsumowanie — „liść”). Adres bez znanego podsumowania jest najpierw podsumowywany.

## Publiczne API

```ts
createNbpFxRateSource({ baseUrl?, sourceId?, http? }) → FxRateSource
createSeriesPriceSource(loadPriceDataset(text)) → PriceSource
createAssetRegistry() → AssetRegistry; createValuator({ fx, prices, assets }) → Valuator
loadCashOutRules(yaml), loadCashOutScoreConfig(yaml)
analyseAddress(input, { labels, valuator, assets, forwarding, rules, score, runId }, ctx)
  → { indicators, events, edges, timeline }
// input: { address, transfers, utxoTxs?, tip?, decisions, counterpartyTransfers?, analysed? }
computeActivity, evaluateCashOut, cashOutScore, buildFundFlow, planCounterpartyExpansion
buildFlowEdges(wiersze, { valuator, assets }, ctx) → FlowEdge[]
buildTimeline(krawędzie, wymiany, zdarzenia, opcje?) → FlowTimelineEntry[]
buildSankey(krawędzie, ziarna, etykiety, opcje?) → FundFlowSankey
planHopExpansion(front, zależności, budżet?) → HopPlanItem[]
```
