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

## Uruchomienie

`pnpm dev` (razem z resztą aplikacji) albo `pnpm --filter @olcys/api dev`. Bez `DATABASE_URL` dane trzymane są
w pamięci (ostrzeżenie w dzienniku). Tryb pobierania określa `OLCYS_MODE` (`offline` domyślnie).

## Testy

`pnpm vitest run --project @olcys/api` — przebiegi na magazynie w pamięci, bez sieci.
