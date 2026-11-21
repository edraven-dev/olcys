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
```
