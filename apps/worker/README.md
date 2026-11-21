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
3. **Analiza łańcucha** (`chain.fetch`) — wstępna selekcja (lista wykluczeń, etykiety), dane łańcucha przez klienta ruchu
   wychodzącego (offline ze strony testowej), reguły odrzucania A1/A2/A4/A8, rozszerzenie o kontrahentów, aktywność
   i wskaźniki wyjścia do fiat wyceniane w PLN (NBP). Adres giełdy nigdy nie jest przypisywany osobie, ale interakcja
   jest rejestrowana; trop KYC tylko dla adresu podanego w pierwszej osobie.
4. **Punktacja** (`score.links`) — Wskaźnik Pewności dla powiązań; migawka konfiguracji przebiegu zapisuje wersję
   i skrót SHA-256 wag używanych przez punktację.
5. **Raport** (`report.render`) — po wbudowanym porównaniu z poprzednim przebiegiem (`diff.previous`), więc raport
   zawiera wykryte zmiany.

Ponowna ocena (`rescore`) niczego nie pobiera: używa zebranych dowodów i analizy łańcucha ocenianego przebiegu,
ponownie wyodrębnia adresy i liczy wskaźniki.
