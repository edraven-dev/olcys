# @olcys/worker — potok analizy i korzeń kompozycji

Łączy implementacje pakietów z portami `@olcys/core` i wykonuje potok analizy. W MVP potok działa synchronicznie
w procesie API: etapy wykonują się po kolei, zapisują wyniki przez repozytoria i raportują postęp w rekordzie
przebiegu. Porównanie z poprzednim zakończonym przebiegiem sprawy jest wbudowanym krokiem `diff.previous`; etapy
późniejszych kroków według `RUN_STEPS` (raport) wykonują się po nim i widzą wykryte zmiany. Powody niepełności
zgłoszone przez etapy (`markPartial`) są od razu zapisywane w `progress.partial`, więc raport może je pokazać.
Każdy powód ma angielskie zdanie (do logów i narzędzi) oraz — gdy przyczyna jest znana — stabilny kod z parametrami
(`progress.partialCodes`, kody w `PARTIAL_CODES` z `@olcys/core`); interfejs i raport składają z kodu polski tekst
z własnych katalogów (`pl.overview.partialReasons`, `pl.summary.partialReasons`), a nieznany kod pokazują jako zdanie
z etapu.

## Publiczne API

- `createRuntime(options)` — buduje środowisko: repozytoria (PostgreSQL przy `DATABASE_URL`, inaczej w pamięci),
  magazyn treści (`OLCYS_DATA_DIR/blobs`), rejestr źródeł z `config/sources.yaml`, migawkę konfiguracji przebiegu
  (skróty SHA-256 rejestru źródeł i wag), tryb (`OLCYS_MODE`) oraz `startRun()`, który tworzy przebieg i uruchamia potok
  bez czekania na wynik, i `launchRun(runId)`, który uruchamia potok przebiegu utworzonego wcześniej (z tego korzysta
  planista).
- `runPipeline(runId, deps)` — wykonuje etapy (`Stage`: `step` + `run(ctx)`), aktualizuje status (`running` →
  `succeeded`, `partial` gdy część źródeł lub danych łańcucha była niedostępna, albo `failed` z komunikatem błędu)
  i zapisuje zmiany. Ponowna ocena dziedziczy powody niepełności ocenianego przebiegu (razem z kodami). Błąd na
  dowolnym etapie przygotowania — także odczyt ocenianego przebiegu — kończy przebieg jako `failed` z komunikatem;
  przebieg nigdy nie zostaje w stanie `queued`.
- `diffWithPrevious(repos, run)` — porównanie z poprzednim przebiegiem przez `diffRuns` z `@olcys/evidence`.
- `loadConfig()` — rejestr źródeł i migawka konfiguracji.
- `createScheduler({ runtime, settings?, clock? })` — planista analiz okresowych (zob. `docs/architecture.md`,
  „Analizy okresowe”): `start()` uzgadnia stan z bazą (`reconcile()`), od razu obsługuje termin do nadrobienia, a potem
  sprawdza harmonogramy co `OLCYS_SCHEDULER_INTERVAL_SECONDS`; `stop()` czeka na trwające sprawdzenie. `evaluate()`
  i `fire(caseId, termin)` obsługują terminy (jeden wpis `schedule_tick` na termin, bez nakładania się przebiegów
  sprawy; termin, który przestał być należny dla bieżącego harmonogramu, nie jest obsługiwany). Uruchamia go proces API.
- `validateCron(cron, { mode, minIntervalMinutes, now })` — sprawdza wyrażenie cron (pięć pól, UTC; bez makr, pola
  sekund, `H`, RRULE i jednoczesnego ograniczenia obu pól dnia; w trybie `live` minimalny odstęp terminów) i zwraca trzy
  najbliższe terminy; `latestOccurrence()` i `nextOccurrences()` liczą terminy (cron-parser).
- `schedulingSettings(env)` — `OLCYS_SCHEDULER_INTERVAL_SECONDS` (domyślnie 30) i `OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`
  (domyślnie 60); wartość niebędąca dodatnią liczbą całkowitą zatrzymuje start.

Etapy (zbieranie, wyodrębnianie adresów, analiza łańcucha, punktacja, raport) rejestruje proces API
(`apps/api/src/stages.ts`).

## Znakowanie czasem (RFC 3161)

`createTrustedTimestamper(...)` (`src/timestamper.ts`, udostępniany jako `runtime.timestamper`) prosi usługę znakowania czasem
o token dla skrótu `manifestSha256` każdego zapisanego przechwycenia (etap zbierania woła go tuż po zapisie). Tylko w trybie
`live` wysyła zapytanie; w `offline` i `replay` zapisuje żądanie `queued` bez połączenia, a przy `TSA_ENABLED=false`
— `queued: disabled`. Awaria TSA nie przerywa przebiegu: żądanie zapisuje się jako `failed` i czeka na ponowienie.

- `flush({ limit?, subjectIds? })` — ponawia oczekujące żądania (tylko `live` i `TSA_ENABLED=true`); idempotentne (jeden
  token na skrót). Wywołuje je polecenie `pnpm --filter @olcys/worker tsa:flush` oraz harmonogram: raz przy starcie i
  co `flushIntervalSeconds` (domyślnie 600 s), gdy `canFlush`.
- Zmienne: `TSA_ENABLED`, `TSA_URL`, `TSA_SOURCE_ID`, `TSA_POLICY_OID`, `TSA_QUALIFIED`, `TSA_TRUST_ANCHORS`,
  `TSA_TIMEOUT_MS`, `TSA_MAX_CLOCK_SKEW_SECONDS`, `TSA_USERNAME`/`TSA_PASSWORD` (zob. `.env.example`). Przy starcie host z
  `TSA_URL` musi być w `allowedHosts` źródła `TSA_SOURCE_ID` (rodzaj `timestamping`); inaczej start kończy się błędem
  `tsa_host_not_allow_listed`.

## Etapy przebiegu

`defaultStages({ mode, sources, env })` zwraca etapy MVP w kolejności potoku:

1. **Zbieranie** (`collect.source`) — kolektory przez jednego klienta ruchu wychodzącego na przebieg (lista dozwolonych hostów,
   robots.txt, dziennik ruchu i koperty pochodzenia zapisywane w magazynie). Treść stron jest maskowana z kluczy prywatnych
   i fraz seed przed zapisem (`createSecretRedactor()` z pakietu wyodrębniania adresów). Oprócz kolektorów platform
   rejestrowane są wyszukiwarki według `OLCYS_SEARCH_MODE` (domyślnie `mock` — wyszukiwarka testowa po stronie testowej;
   zob. `packages/collectors/README.md`); klucze API pochodzą wyłącznie ze zmiennych środowiskowych. Rejestr kolektorów
   powstaje raz, przy tworzeniu etapu, więc błędna wartość `OLCYS_SEARCH_MODE` zatrzymuje start procesu.
2. **Wyodrębnianie adresów** (`extract.capture`) — dla każdego udanego przechwycenia; lista wykluczeń
   `config/rules/deny-list.v1.yaml`. Listy wyników wyszukiwarek (`isSearchResultCapture()`) są pomijane: to tylko
   wskazania stron, a same strony zbierają i przetwarzają ich kolektory, więc fragment wyniku nie staje się drugą kopią
   wzmianki o adresie.
3. **Analiza łańcucha** (`chain.fetch`) — wstępna selekcja (lista wykluczeń, etykiety), dane łańcucha przez klienta ruchu
   wychodzącego (offline ze strony testowej), typ każdego pobranego adresu (`classifyAddress` z `@olcys/labels`: kod
   z pobrania i sondy przez tego samego dostawcę — EOA, delegacja EIP-7702, Safe, ERC-4337, kontrakt tokena, kontrakt,
   typ skryptu Bitcoin; zapis w `addressTypes`, nieudana sonda oznacza przebieg jako `partial`), reguły odrzucania
   A1–A4/A8 (A3 z rejestrem delegatów `config/labels/eip7702-delegates.v1.yaml`), rozszerzenie o kontrahentów, aktywność
   i wskaźniki wyjścia do fiat wyceniane w PLN (NBP). Dla adresów Bitcoin sprawy etap buduje klastry wspólnego
   wydatkowania (`src/clusters.ts`, heurystyka z bezpiecznikami CoinJoin i usług — zob.
   [metodyka](../../docs/methodology/klastrowanie-wspolwydatkowania.md)): historie partnerów są pobierane tym samym klientem
   ruchu wychodzącego (≤ 200 adresów, głębokość 2, ≤ 5 stron; bez usług i adresów z listy wykluczeń), klastry są
   zapisywane w `clusters` (tylko do dopisywania), a reguła A7 oznacza ziarna klastra, który wchłonął usługę, osiągnął
   limit lub gwałtownie urósł względem poprzedniego przebiegu. Niepełna historia partnera daje powód `partial`
   z kodem `counterparty_chain_incomplete`. Punktacja dostaje członków klastra jako powiązania `CLUSTER_ASSOCIATED`
   (wynik 0, „nie oceniono”) wyłącznie dla ziaren z roszczeniem własności. Adresy otrzymują tylko dostawcy włączeni w zakresie sprawy
   (AMBER, np. `etherscan_v2`, `trongrid`, z uzasadnieniem analityka); kursy NBP przy włączonym `nbp_api`. Historia
   pobrana niecałkowicie (brak włączonego dostawcy, blokada, brak nagrania, obcięcie) oznacza przebieg jako `partial`.
   Użyte etykiety są zapisywane w magazynie (raport, API). Adres giełdy nigdy nie jest przypisywany osobie, ale
   interakcja jest rejestrowana; trop KYC tylko dla adresu podanego w pierwszej osobie (nie w cytacie, ostrzeżeniu,
   zgłoszeniu oszustwa ani na liście).
4. **Punktacja** (`score.links`) — Wskaźnik Pewności dla powiązań; migawka konfiguracji przebiegu zapisuje wersję
   i skrót SHA-256 wag używanych przez punktację. Tylko w ponownej ocenie etap stosuje korekty analityka sprawy
   zapisane do chwili zlecenia przebiegu (`applyOverrides` z `@olcys/scoring`, moduł `src/analyst.ts`). Zbiór jest
   ustalany przy tworzeniu przebiegu: migawka konfiguracji zapisuje identyfikatory (`analystOverrides`) i etykietę
   `rulesVersions.overrides` (`overrides@<liczba>:<id najnowszej>`), a punktacja stosuje dokładnie ten zbiór.
5. **Raport** (`report.render`) — po wbudowanym porównaniu z poprzednim przebiegiem (`diff.previous`), więc raport
   zawiera wykryte zmiany.

Ponowna ocena (`rescore`) niczego nie pobiera: używa zebranych dowodów i analizy łańcucha ocenianego przebiegu,
ponownie wyodrębnia adresy i liczy wskaźniki. Braki danych ocenianego przebiegu pozostają widoczne (status `partial`
z tymi samymi powodami). Wykryte adresy mają w niej nowe identyfikatory; korekty wskazujące adresy wcześniejszego
przebiegu są odnajdywane po zabezpieczeniu i położeniu w tekście. Oceny analityka nie uruchamiają żadnego przebiegu.

## Dane syntetyczne a tryb `live`

Etykiety demonstracyjne (`fixtures/labels/demo-curated.json`) i syntetyczny zbiór cen (`fixtures/prices/demo-prices.v1.json`)
ładuje wyłącznie etap analizy łańcucha w trybach `offline` i `replay`. W trybie `live` obowiązuje zasada: syntetyczne
etykiety nie rozstrzygają o prawdziwych adresach, a syntetyczne ceny nigdy nie wyceniają prawdziwych transakcji — używa
się tylko etykiet z magazynu (bez etykiet oznaczonych jako syntetyczne, np. zbioru `demo-curated` pozostawionego w bazie przez przebieg offline) i nie ma źródła cen, więc przepływy wymagające ceny są „bez wyceny”. Brak wyceny w PLN
(brak ceny albo kursu NBP, np. gdy `nbp_api` nie jest włączone lub NBP nie odpowiada) oznacza przebieg jako `partial`
z kodem `valuation_unavailable` i liczbą transferów bez wyceny (token spoza rejestru aktywów nie jest błędem wyceny).

Offline i w nagraniach kursy NBP (tabela A) pochodzą ze strony testowej (`/nbp/api/…`, prefiks `api.nbp.pl/api`
w `hostPrefixes` manifestu): wartości są syntetyczne, a numer tabeli ma przedrostek `SYN`, więc raport pokazuje, że
wycena nie opiera się na prawdziwych kursach. Wycena oparta na odpowiedzi ze źródła syntetycznego ma w odnośniku do
NBP znacznik `synthetic: true`; raport i interfejs dodają przy niej „(kurs syntetyczny — dane demonstracyjne)”.

## Wybór łańcuchów i zapis transferów

`scope.chains` sprawy ogranicza analizę łańcucha: pomijani są kandydaci z innych łańcuchów (adres `evm:unknown` jest
analizowany, gdy wybrano dowolny łańcuch EVM; pusta lista oznacza wszystkie). Pominięcie to decyzja analityka, więc
nie czyni przebiegu `partial` — etap zapisuje tylko notatkę w postępie (`skippedByChain`, `skippedChains`) i w logu.

Transfer między dwoma analizowanymi adresami jest zapisywany raz na przebieg (klucz `transferKey` z `@olcys/core`);
odczyt `listTransfers` także usuwa powtórzenia, więc raport i API nie liczą go podwójnie.
