# @olcys/api — API konsoli analityka

Serwer HTTP (Fastify) dla interfejsu analityka. Nasłuchuje wyłącznie na `127.0.0.1:4000`; interfejs łączy się przez
serwer deweloperski Vite (`/api`). W MVP uruchamia też potok analizy w tym samym procesie (`@olcys/worker`).

## Trasy

| Metoda i ścieżka                                                    | Opis                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/health`                                                   | stan usługi i wersja kontraktów                                                    |
| `GET /api/sources`                                                  | rejestr źródeł ze statusem zgodności (GREEN/AMBER/RED)                             |
| `GET /api/cases`, `POST /api/cases`, `GET /api/cases/:id`           | sprawy i ich identyfikatory (walidacja schematem `CreateCaseSchema`)               |
| `GET /api/cases/:id/runs`, `POST /api/cases/:id/runs`               | przebiegi sprawy; `POST` tworzy przebieg i uruchamia potok (odpowiedź 202)         |
| `GET /api/cases/:id/schedule`, `PUT /api/cases/:id/schedule`        | harmonogram analiz okresowych: cron (UTC), najbliższe terminy, wyzwolenia, zmiany  |
| `GET /api/runs/:id`                                                 | status i postęp przebiegu                                                          |
| `GET /api/runs/:id/{captures,observations,accounts,candidates}`     | dowody: przechwycenia stron, fakty, konta, kandydaci adresów                       |
| `GET /api/runs/:id/extractions`                                     | wyniki ekstrakcji z dopasowaniami odrzuconymi przy weryfikacji (np. homoglify)     |
| `GET /api/runs/:id/{links,exclusions,activity,cash-outs,transfers}` | wyniki: powiązania ze Wskaźnikiem Pewności, odrzucenia, aktywność, wyjścia do fiat |
| `GET /api/runs/:id/changes`                                         | zmiany względem poprzedniego przebiegu (m.in. podmiana portfela)                   |
| `GET /api/runs/:id/egress`                                          | dziennik ruchu wychodzącego przebiegu                                              |
| `GET /api/runs/:id/report`                                          | raport HTML przebiegu                                                              |
| `GET /api/labels`                                                   | etykiety adresów z pochodzeniem (zbiór danych, URL, licencja, data zmiany)         |
| `GET /api/captures/:id`, `GET /api/blobs/:sha256`                   | metadane przechwycenia; surowa treść dowodu wyłącznie jako plik do pobrania        |

Treść pobrana ze stron jest niezaufana: `/api/blobs` zwraca ją jako załącznik `application/octet-stream` z nagłówkami
`nosniff` i `Content-Security-Policy: sandbox`, nigdy jako stronę w domenie konsoli.

## Harmonogram analiz

Proces API uruchamia też planistę analiz okresowych (`createScheduler` z `@olcys/worker`, zob. `docs/architecture.md`):
co `OLCYS_SCHEDULER_INTERVAL_SECONDS` (domyślnie 30 s) obsługuje należne terminy harmonogramów i zatrzymuje się razem
z serwerem. `PUT /api/cases/:id/schedule` przyjmuje `{ cron, enabled, reason }` (powód jest wymagany) i zwraca stan
harmonogramu (`CaseScheduleState`). Autor zmiany pochodzi z konfiguracji serwera (`OLCYS_ANALYST_NAME`, domyślnie
`analyst`), nigdy z żądania. Błędy: 400 `invalid_cron` (inne niż pięć pól, makra, pole sekund, `H`, RRULE),
400 `schedule_too_frequent` (w trybie `live` terminy bliżej niż `OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`, domyślnie 60 min;
w trybach `offline` i `replay` minimum to 1 min), 400 `invalid_input`, 404 `case_not_found`, 409 `case_closed`.

## Uruchomienie

`pnpm dev` (razem z resztą aplikacji) albo `pnpm --filter @olcys/api dev`. Bez `DATABASE_URL` dane trzymane są
w pamięci (ostrzeżenie w dzienniku). Tryb pobierania określa `OLCYS_MODE` (`offline` domyślnie).

## Testy

`pnpm vitest run --project @olcys/api` — przebiegi na magazynie w pamięci, bez sieci.

## Kontrola zakresu źródeł

`POST /api/cases` odrzuca (400 `invalid_scope`) źródła RED, nieznane identyfikatory źródeł oraz źródła AMBER bez
uzasadnienia (co najmniej 20 znaków) — niezależnie od interfejsu. Kolektory sprawdzają to samo ponownie przy zbieraniu.
