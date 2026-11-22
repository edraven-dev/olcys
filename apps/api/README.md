# @olcys/api — API konsoli analityka

Serwer HTTP (Fastify) dla interfejsu analityka. Nasłuchuje wyłącznie na `127.0.0.1:4000`; interfejs łączy się przez
serwer deweloperski Vite (`/api`). W MVP uruchamia też pipeline analizy w tym samym procesie (`@olcys/worker`).

## Trasy

| Metoda i ścieżka                                                    | Opis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                   | stan usługi i wersja kontraktów                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/meta`                                                     | wersja, tryb, funkcje (`features`; `features.inferenceDrafts` jest prawdą, gdy model jest włączony i API ma moduł szkiców wniosków — wtedy konsola pokazuje przycisk „Zaproponuj wnioski (AI)”), wersje wag i reguł, status wag, wersja ekstraktora, model AI (tylko host, model, stan; bez klucza), zmienne wyłączające telemetrię (nazwa i czy ustawiona)                                                                                                                                                             |
| `GET /api/sources`                                                  | rejestr źródeł ze statusem zgodności (GREEN/AMBER/RED)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/cases`, `POST /api/cases`, `GET /api/cases/:id`           | sprawy i ich identyfikatory (walidacja schematem `CreateCaseSchema`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/cases/:id/runs`, `POST /api/cases/:id/runs`               | przebiegi sprawy; `POST` tworzy przebieg i uruchamia pipeline (odpowiedź 202)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/cases/:id/schedule`, `PUT /api/cases/:id/schedule`        | harmonogram analiz okresowych: cron (UTC), najbliższe terminy, wyzwolenia, zmiany                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/cases/:id/timeline`                                       | historia wartości stron i pól profilu: kopie archiwalne i przebiegi; filtry `url`, `property`, `walletOnly`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/runs/:id`                                                 | status i postęp przebiegu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/runs/:id/{captures,observations,accounts,candidates}`     | dowody: przechwycenia stron, fakty, konta, kandydaci adresów                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/runs/:id/extractions`                                     | wyniki ekstrakcji z dopasowaniami odrzuconymi przy weryfikacji (np. homoglify)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/runs/:id/{links,exclusions,activity,cash-outs,transfers}` | wyniki: powiązania ze Wskaźnikiem Pewności, odrzucenia, aktywność, wyjścia do fiat                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/runs/:id/flows`                                           | krawędzie przepływów środków (obliczenia; `hop` > 0 w dół, < 0 w górę), z wyceną w PLN                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/runs/:id/fund-flows`                                      | oś czasu i agregat Sankey każdego analizowanego adresu (`truncated` — graf przycięty)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/runs/:id/address-types`                                   | typy adresów z analizy łańcuchowej (EOA, EIP-7702, Safe, ERC-4337, kontrakt…)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/runs/:id/clusters`                                        | klastry Bitcoin (heurystyka wspólnego wydatkowania): dowody połączeń, pominięcia                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/links/:linkId/judgements`, `POST …/judgements`            | oceny analityka przy powiązaniu (od najstarszej); nie zmieniają wyniku                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/cases/:id/overrides`, `POST /api/cases/:id/overrides`     | korekty analityka w sprawie; działają dopiero w ponownej ocenie (`rescore`)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/runs/:id/report`                                         | nowa wersja raportu zakończonego przebiegu (z ocenami zapisanymi do tej chwili)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/runs/:id/changes`                                         | zmiany względem poprzedniego przebiegu (m.in. podmiana portfela)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/runs/:id/egress`                                          | dziennik ruchu wychodzącego przebiegu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/runs/:id/report`                                          | raport HTML przebiegu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/runs/:runId/report/drafts`                               | szkice wniosków AI do sekcji C na prośbę analityka (jedno ograniczone wywołanie modelu, sugestie o wadze 0): 200 z `status` `drafted` (liczba szkiców i odrzuconych przez kontrolę), `skipped` (`nothing_to_draft`, `pending_drafts`, `busy`, `no_report`) albo `failed` (typowana przyczyna awarii modelu, nie błąd); 404 dla nieznanego przebiegu; 409 `llm_disabled` przy wyłączonym modelu. Decyzja: `POST /api/suggestions/:id/decision` (opcjonalnie `editedText`); do raportu trafiają tylko szkice potwierdzone |
| `GET /api/runs/:id/report/view`                                     | model raportu (`ReportModel`) zbudowany z tych samych danych co HTML oraz pliki jednej wersji z rozmiarem i SHA-256 (404 do czasu pełnej publikacji)                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/runs/:id/report/versions/:wersja/:rodzaj`                 | plik jednej opublikowanej wersji raportu (`html`, `manifest` lub eksport) — dokładnie te bajty, które wymienia `report/view`                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/runs/:id/exports`                                         | lista eksportów bieżącej wersji raportu (pusta dla starszych raportów)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/runs/:id/exports/:format`                                 | eksport raportu: `stix`, `misp`, `csv_links`, `csv_evidence`, `csv_cash_out`, `csv_changes`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/labels`                                                   | etykiety adresów z pochodzeniem (zbiór danych, URL, licencja, data zmiany)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/captures/:id`, `GET /api/blobs/:sha256`                   | metadane przechwycenia; surowa treść dowodu wyłącznie jako plik do pobrania                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Treść pobrana ze stron jest niezaufana: `/api/blobs` zwraca ją jako załącznik `application/octet-stream` z nagłówkami
`nosniff` i `Content-Security-Policy: sandbox`, nigdy jako stronę w domenie konsoli.

## Ochrona przed DNS rebinding i żądaniami z innych witryn

API nie ma uwierzytelniania, więc każde żądanie przechodzi przez strażnika (`src/guard.ts`, hak `onRequest`):

- nagłówek `Host` musi wskazywać `localhost`, `127.0.0.1` lub `[::1]` (dowolny port) albo host z
  `OLCYS_API_ALLOWED_HOSTS` (lista rozdzielana przecinkami; sama nazwa dopuszcza dowolny port, `nazwa:port` jeden);
  inaczej odpowiedź to 421 `misdirected_request`;
- żądanie zmieniające stan (`POST`, `PUT`, `PATCH`, `DELETE`) z nagłówkiem `Origin` musi pochodzić z interfejsu
  (`http://localhost:5173`, `http://127.0.0.1:5173`, `http://[::1]:5173`; port z `WEB_PORT`) albo z hosta
  z `OLCYS_API_ALLOWED_HOSTS`; inaczej 403 `forbidden_origin`. Żądania bez `Origin` (curl, skrypty) i odczyty
  (`GET`, `HEAD`) przechodzą.

Serwer deweloperski Vite przekazuje nagłówki `Host` i `Origin` przeglądarki bez zmian, więc `pnpm dev` działa bez
konfiguracji.

## Harmonogram analiz

Proces API uruchamia też planistę analiz okresowych (`createScheduler` z `@olcys/worker`, zob. `docs/architecture.md`):
co `OLCYS_SCHEDULER_INTERVAL_SECONDS` (domyślnie 30 s) obsługuje należne terminy harmonogramów i zatrzymuje się razem
z serwerem. `PUT /api/cases/:id/schedule` przyjmuje `{ cron, enabled, reason }` (powód jest wymagany) i zwraca stan
harmonogramu (`CaseScheduleState`). Autor zmiany pochodzi z konfiguracji serwera (`OLCYS_ANALYST_NAME`, w razie braku
`OLCYS_COLLECTOR_NAME`, domyślnie `analyst`), nigdy z żądania. Błędy: 400 `invalid_cron` (inne niż pięć pól, makra,
pole sekund, `H`, RRULE), 400 `schedule_too_frequent` (w trybie `live` terminy bliżej niż
`OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`, domyślnie 60 min; w trybach `offline` i `replay` minimum to 1 min), 400
`invalid_input`, 404 `case_not_found`, 409 `case_closed`.

## Oś czasu strony

`GET /api/cases/:id/timeline?url=&property=&walletOnly=true` zwraca `PropertyTimeline[]` zbudowane z przechwyceń,
kandydatów i faktów wszystkich przebiegów sprawy oraz wykazu snapshotów Wayback (`buildWaybackHistory`). Wszystkie filtry
są opcjonalne; `walletOnly` przyjmuje wyłącznie `true` lub `false`, a nieprawidłowy filtr (lub nieznany parametr)
daje 400 `invalid_input` ze ścieżką błędnego pola w `issues`. Trasa tylko czyta zapisane dane. Osie stron powstają dla
stron, które mają kopie archiwalne; osie pól profilu (np. `profile.bitcoin_address`) — z faktów przebiegów na żywo.
Punkty kopii archiwalnych mają `provenance: "archive"` i czas snapshotu z archiwum; luki (`values: null`) nigdy nie
oznaczają usunięcia adresu. Dla każdego przechwycenia liczy się wynik wyodrębnienia z najnowszej analizy (ponowna
ocena zastępuje wcześniejszy wynik); przechwycenie, którego wyodrębnienie jeszcze się nie zakończyło, jest luką
(`extraction_pending`). Wiele pobrań tego samego snapshotu łączy się tak: użyteczne (status `ok`, skrót zgodny) wygrywa z
niepobranym lub błędnym, a spośród równych — najnowsze.

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

`POST /api/cases` waliduje zakres sprawy względem rejestru źródeł (`validateCaseScope` z `@olcys/collectors`) —
niezależnie od interfejsu. Odpowiedź 400 ma postać `{ error: <kod pierwszego naruszenia>, message, details: [naruszenia] }`.
Kody: `source_forbidden` (źródło RED), `unknown_source`, `amber_justification_required` (źródło AMBER bez uzasadnienia),
`justification_too_short` (uzasadnienie krótsze niż 20 znaków; `details[].minLength`), `orphan_justification` (uzasadnienie
dla źródła niewłączonego lub spoza AMBER), `pivot_depth_out_of_range` (głębokość 0–3) i `unknown_chain`. Kolektory
sprawdzają to samo ponownie przy zbieraniu.

## Model raportu i pliki

`GET /api/runs/:id/report/view` czyta zapisane dane raportu (`data_json`) i buduje z nich `ReportModel` funkcją
`buildReportModel` z `@olcys/reporting`; API nie zawiera własnej logiki renderowania. Odpowiedź ma też listę plików
(`html`, `pdf`, `manifest`, `timestamp`, eksporty) z rozmiarem, SHA-256 i ścieżką związaną z wersją (`version` w odpowiedzi to skrót wpisu `export_set`, rejestrowanego jako ostatni, więc wersja niepełna nie jest listowana; ponowne wygenerowanie raportu nie zmienia tego, co serwuje wcześniej wydany odnośnik). Raport zapisany w starym formacie (zestaw bez `runId` i skrótu danych) jest zwracany jako `{ legacy: true, files }` — bieżący HTML i eksporty bez gwarancji wersji, konsola prosi o ponowne wygenerowanie. Błąd odczytu lub parsowania zapisanego raportu lub wersji (także uszkodzony blob) to 500, a nie „brak raportu”; 404 oznacza brak wiersza lub wersji; PDF/A jest
oznaczony jako niedostępny do czasu wdrożenia kroku PDF, a znaczniki RFC 3161 pojawiają się tylko dla zabezpieczeń, które je mają.
Pobieranie plików nie wymaga logowania; opcjonalny nagłówek `X-Olcys-Purpose` (wartość zakodowana `encodeURIComponent`)
niesie cel pobrania: trafia do dziennika dostępu (`statedPurpose`, pobrania wersji i eksportów są zawsze logowane, bez deduplikacji) i do zdarzenia `exported` w łańcuchu dowodowym, które bez nagłówka zapisuje cel sprawy.

`GET /api/meta` zwraca ustawienia tylko do odczytu dla strony „Ustawienia”: z adresu modelu AI wystawia wyłącznie host
(bez danych logowania, ścieżki i zapytania), nigdy klucza API; zmienne wyłączające telemetrię są podane z nazwy i stanem
(ustawiona lub nie), bez wartości. Dane te przekazuje `settings` w `buildApp` (kompozycja w `main.ts`).

## Eksporty raportu

`GET /api/runs/:id/exports/:format` zwraca najnowszy eksport przebiegu (STIX 2.1, MISP lub jedną z czterech tabel CSV —
zob. `packages/reporting/README.md`) jako załącznik z nagłówkami `x-content-type-options: nosniff` i
`content-security-policy: sandbox`. Plik jest czytany i sprawdzany względem skrótu SHA-256 przed wysłaniem (brak lub uszkodzenie: 404 / 500); zdarzenie zapisuje wyłącznie udane `GET` tuż przed wysłaniem (nie `HEAD`). Eksporty pochodzą zawsze z tej samej wersji raportu co HTML. Każde pobranie zapisuje w łańcuchu dowodowym zdarzenie `exported` (podmiot: raport
przebiegu; szczegóły: format, skrót SHA-256 pliku i cel sprawy), z analitykiem z konfiguracji serwera. Nieznany format to
400, nieznany przebieg lub brak eksportu — 404. Znacznik TLP i nazwa producenta STIX pochodzą ze zmiennych
`OLCYS_EXPORT_TLP` (domyślnie `amber`) i `OLCYS_STIX_PRODUCER_NAME`.

## Nagłówki bezpieczeństwa i dziennik dostępu

Hak `onSend` (`src/security.ts`) dodaje do każdej odpowiedzi ścisłe CSP (`default-src 'none'; frame-ancestors 'none'`),
`nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` i `Cache-Control: no-store`; HSTS tylko przy
`OLCYS_HSTS=1`. Raport HTML dopuszcza swoje arkusze stylów po skrócie SHA-256. Odczyty spraw, uruchomień, dowodów,
raportów i eksportów trafiają w tle do dziennika dostępu (`GET /api/access-log`): podmiotem jest etykieta analityka
(`OLCYS_ANALYST_NAME`, inaczej `local`), cel tylko wtedy, gdy klient prześle nagłówek `X-Olcys-Purpose`
(zakodowany `encodeURIComponent`, bo wartości nagłówków to Latin-1; API dekoduje go, przy błędnej sekwencji zachowuje
wartość surową, przycina i ogranicza do 500 znaków). Powtórzone identyczne odczyty (odpytywanie postępu) są w oknie
60 s zapisywane raz; pobrania plików, raportów i eksporty zawsze. Konta i logowanie
są planowane w kolejnej wersji (poza zakresem MVP). Szczegóły: `docs/security.md`.
