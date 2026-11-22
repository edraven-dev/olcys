# @olcys/api — API konsoli analityka

Serwer HTTP (Fastify) dla interfejsu analityka. Nasłuchuje wyłącznie na `127.0.0.1:4000`; interfejs łączy się przez
serwer deweloperski Vite (`/api`). W MVP uruchamia też potok analizy w tym samym procesie (`@olcys/worker`).

## Trasy

| Metoda i ścieżka                                                    | Opis                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/health`                                                   | stan usługi i wersja kontraktów                                                    |
| `GET /api/meta`                                                     | wersja, tryb, włączone funkcje (`features`), wersje wag i reguł                    |
| `GET /api/sources`                                                  | rejestr źródeł ze statusem zgodności (GREEN/AMBER/RED)                             |
| `GET /api/cases`, `POST /api/cases`, `GET /api/cases/:id`           | sprawy i ich identyfikatory (walidacja schematem `CreateCaseSchema`)               |
| `GET /api/cases/:id/runs`, `POST /api/cases/:id/runs`               | przebiegi sprawy; `POST` tworzy przebieg i uruchamia potok (odpowiedź 202)         |
| `GET /api/cases/:id/schedule`, `PUT /api/cases/:id/schedule`        | harmonogram analiz okresowych: cron (UTC), najbliższe terminy, wyzwolenia, zmiany  |
| `GET /api/runs/:id`                                                 | status i postęp przebiegu                                                          |
| `GET /api/runs/:id/{captures,observations,accounts,candidates}`     | dowody: przechwycenia stron, fakty, konta, kandydaci adresów                       |
| `GET /api/runs/:id/extractions`                                     | wyniki ekstrakcji z dopasowaniami odrzuconymi przy weryfikacji (np. homoglify)     |
| `GET /api/runs/:id/{links,exclusions,activity,cash-outs,transfers}` | wyniki: powiązania ze Wskaźnikiem Pewności, odrzucenia, aktywność, wyjścia do fiat |
| `GET /api/runs/:id/address-types`                                   | typy adresów z analizy łańcuchowej (EOA, EIP-7702, Safe, ERC-4337, kontrakt…)      |
| `GET /api/links/:linkId/judgements`, `POST …/judgements`            | oceny analityka przy powiązaniu (od najstarszej); nie zmieniają wyniku             |
| `GET /api/cases/:id/overrides`, `POST /api/cases/:id/overrides`     | korekty analityka w sprawie; działają dopiero w ponownej ocenie (`rescore`)        |
| `POST /api/runs/:id/report`                                         | nowa wersja raportu zakończonego przebiegu (z ocenami zapisanymi do tej chwili)    |
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
harmonogramu (`CaseScheduleState`). Autor zmiany pochodzi z konfiguracji serwera (`OLCYS_ANALYST_NAME`, w razie braku
`OLCYS_COLLECTOR_NAME`, domyślnie `analyst`), nigdy z żądania. Błędy: 400 `invalid_cron` (inne niż pięć pól, makra,
pole sekund, `H`, RRULE), 400 `schedule_too_frequent` (w trybie `live` terminy bliżej niż
`OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`, domyślnie 60 min; w trybach `offline` i `replay` minimum to 1 min), 400
`invalid_input`, 404 `case_not_found`, 409 `case_closed`.

## Oceny i korekty analityka

Analityk jest brany z konfiguracji serwera (`OLCYS_ANALYST_NAME`, w razie braku `OLCYS_COLLECTOR_NAME`, domyślnie
`analyst` — ta sama tożsamość co przy sprawach i zmianach harmonogramu), nigdy z treści żądania (pole `analyst`
w treści jest pomijane). Ocena (`{ judgement: 'same' | 'not_same' | 'unsure', justification }`) jest zapisywana obok
powiązania — zapisany wynik pozostaje bajtowo identyczny, a `GET /api/runs/:id/links` zwraca przy każdym powiązaniu
listę `judgements`. Korekta (`{ kind, target, value, justification }`) musi dotyczyć elementu z przebiegu sprawy
i zmienia dane wejściowe dopiero przebiegu ponownej oceny. Szczegóły:
[metodyka Wskaźnika Pewności](../../docs/methodology/wskaznik-pewnosci.md).

Błędy: 404 `link_not_found`; 422 `justification_too_short` / `justification_too_long` (10–2000 znaków po przycięciu),
`feature_not_allowed`, `grade_not_allowed` (ocena F), `invalid_value`, `invalid_target`, `target_not_found`,
`candidate_not_review_required`; 409 `run_not_finished` (raport tylko dla zakończonego przebiegu). Każda ocena i korekta
jest odnotowywana w dzienniku (analityk i identyfikatory, bez treści).

## Uruchomienie

`pnpm dev` (razem z resztą aplikacji) albo `pnpm --filter @olcys/api dev`. Bez `DATABASE_URL` dane trzymane są
w pamięci (ostrzeżenie w dzienniku). Tryb pobierania określa `OLCYS_MODE` (`offline` domyślnie).

## Testy

`pnpm vitest run --project @olcys/api` — przebiegi na magazynie w pamięci, bez sieci.

## Kontrola zakresu źródeł

`POST /api/cases` odrzuca (400 `invalid_scope`) źródła RED, nieznane identyfikatory źródeł oraz źródła AMBER bez
uzasadnienia (co najmniej 20 znaków) — niezależnie od interfejsu. Kolektory sprawdzają to samo ponownie przy zbieraniu.
