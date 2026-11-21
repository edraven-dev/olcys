# @olcys/http

Klient HTTP z kontrolą ruchu wychodzącego: lista dozwolonych hostów, limity zapytań na host, robots.txt, koperty pochodzenia danych (provenance), tryby nagrywania, odtwarzania i offline. Jedyny moduł, który może otwierać połączenia sieciowe.

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/http`.

## Publiczne API

- `createEgressClient(options)` — tworzy klienta portu `EgressClient` z `@olcys/core`. Najważniejsze opcje: `mode` (`live` / `offline` / `replay`), `enabledSources` (źródła włączone dla przebiegu — ich `allowedHosts` tworzą listę dozwolonych hostów), `blobs` (magazyn treści), `sinks` (zapis dziennika ruchu i kopert pochodzenia), `cassetteDir` i `record` (nagrania), `toolVersion`; opcjonalnie `localHosts`, `extraAllowedHosts`, `maxRedirects` (domyślnie 5), `maxBodyBytes` (domyślnie 25 MB).
- `RobotsCache` — pobiera i buforuje `robots.txt` przez klienta; `parseRobots` i `isAllowedByRobots` realizują dopasowanie wg RFC 9309 (najdłuższa reguła wygrywa, przy remisie `Allow`).
- `redactUrl`, `requestHash`, `normaliseHost` — funkcje pomocnicze (maskowanie sekretów, klucz nagrania, normalizacja hosta).
- Błędy: `EgressDeniedError` (źródło niewłączone lub RED, host spoza listy, zablokowane przekierowanie) oraz `ReplayMissError` (brak nagrania w trybie `offline` / `replay`).

## Zasady działania

1. Każde żądanie i każdy krok przekierowania są sprawdzane z listą dozwolonych hostów źródła. Źródła RED oraz hosty z `blockedHosts` są zawsze odrzucane.
2. Hosty lokalne (strona testowa, usługi wewnętrzne) są dostępne dla włączonych źródeł, ale przekierowanie z hosta zewnętrznego na host lokalny jest blokowane.
3. Tryb `offline`: na żywo wyłącznie hosty lokalne, pozostałe odpowiedzi pochodzą z nagrań. Tryb `replay`: na żywo wyłącznie usługi wewnętrzne (`internal_service`, `ai_model`) na hostach lokalnych, reszta (także strona testowa) z nagrań. Brak nagrania kończy się błędem `ReplayMissError`.
4. Nagrania powstają tylko w trybie `live` z `record: true` (`OLCYS_RECORD=1`); adresy w nagraniach nie zawierają sekretów.
5. Limit zapytań liczony jest per host według `rateLimit` źródła.
6. Każda próba trafia do dziennika ruchu: żądania dozwolone, odrzucone i nieudane (pole `error`), z flagą `containsIdentifier`. Parametry z sekretami (`apikey`, `token` itp.) są maskowane jako `REDACTED`.
7. Treść odpowiedzi trafia do magazynu treści (SHA-256), chyba że `persistBody: false` — wtedy zapisywany jest tylko skrót. Każde pobranie opisuje koperta pochodzenia (`ProvenanceEnvelope`), z adresem końcowym po przekierowaniach.
8. Przy przekierowaniu do innego originu nie są przekazywane nagłówki z sekretami ani `cookie`; odpowiedź 303 (oraz 301/302 po POST) zmienia metodę na GET. Odpowiedzi większe niż `maxBodyBytes` są odrzucane w trakcie odczytu.
