# @olcys/worker — potok analizy i korzeń kompozycji

Łączy implementacje pakietów z portami `@olcys/core` i wykonuje potok analizy. W MVP potok działa synchronicznie
w procesie API: etapy wykonują się po kolei, zapisują wyniki przez repozytoria i raportują postęp w rekordzie
przebiegu. Porównanie z poprzednim zakończonym przebiegiem sprawy jest wbudowanym krokiem `diff.previous`; etapy
późniejszych kroków według `RUN_STEPS` (raport) wykonują się po nim i widzą wykryte zmiany. Powody niepełności
zgłoszone przez etapy (`markPartial`) są od razu zapisywane w `progress.partial`, więc raport może je pokazać.

## Publiczne API

- `createRuntime(options)` — buduje środowisko: repozytoria (PostgreSQL przy `DATABASE_URL`, inaczej w pamięci),
  magazyn treści (`OLCYS_DATA_DIR/blobs`), rejestr źródeł z `config/sources.yaml`, migawkę konfiguracji przebiegu
  (skróty SHA-256 rejestru źródeł i wag), tryb (`OLCYS_MODE`) oraz `startRun()`, który tworzy przebieg i uruchamia potok
  bez czekania na wynik, i `launchRun(runId)`, który uruchamia potok przebiegu utworzonego wcześniej (z tego korzysta
  planista).
- `runPipeline(runId, deps)` — wykonuje etapy (`Stage`: `step` + `run(ctx)`), aktualizuje status (`running` →
  `succeeded`, `partial` gdy część źródeł lub danych łańcucha była niedostępna, albo `failed` z komunikatem błędu)
  i zapisuje zmiany. Ponowna ocena dziedziczy powody niepełności ocenianego przebiegu.
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
   wychodzącego (offline ze strony testowej), reguły odrzucania A1/A2/A4/A8, rozszerzenie o kontrahentów, aktywność
   i wskaźniki wyjścia do fiat wyceniane w PLN (NBP). Adresy otrzymują tylko dostawcy włączeni w zakresie sprawy
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
