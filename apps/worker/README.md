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
  bez czekania na wynik.
- `runPipeline(runId, deps)` — wykonuje etapy (`Stage`: `step` + `run(ctx)`), aktualizuje status (`running` →
  `succeeded`, `partial` gdy część źródeł była niedostępna, albo `failed` z komunikatem błędu) i zapisuje zmiany.
- `diffWithPrevious(repos, run)` — porównanie z poprzednim przebiegiem przez `diffRuns` z `@olcys/evidence`.
- `loadConfig()` — rejestr źródeł i migawka konfiguracji.

Etapy (zbieranie, wyodrębnianie adresów, analiza łańcucha, punktacja, raport) rejestruje proces API
(`apps/api/src/stages.ts`).

## Etapy przebiegu

`defaultStages({ mode, sources, env })` zwraca etapy MVP w kolejności potoku:

1. **Zbieranie** (`collect.source`) — kolektory przez jednego klienta ruchu wychodzącego na przebieg (lista dozwolonych hostów,
   robots.txt, dziennik ruchu i koperty pochodzenia zapisywane w magazynie). Treść stron jest maskowana z kluczy prywatnych
   i fraz seed przed zapisem (`createSecretRedactor()` z pakietu wyodrębniania adresów).
2. **Wyodrębnianie adresów** (`extract.capture`) — dla każdego udanego przechwycenia; lista wykluczeń
   `config/rules/deny-list.v1.yaml`.
3. **Punktacja** (`score.links`) — Wskaźnik Pewności dla powiązań; migawka konfiguracji przebiegu zapisuje wersję
   i skrót SHA-256 wag używanych przez punktację.

Porównanie z poprzednim przebiegiem jest wbudowane (`diff.previous`). Analiza łańcucha i raport dołączają do listy etapów
wraz z ich pakietami.
