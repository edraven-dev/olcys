# Architektura OŁCyŚ

OŁCyŚ to deterministyczny **potok dowodowy**, w którym zgodność z zasadami jest wbudowana od początku. Na podstawie
co najmniej jednego identyfikatora badanej osoby (imię i nazwisko, nick z forum, identyfikator z komunikatora, login
z portalu społecznościowego, e-mail lub adres kryptowalutowy) narzędzie:

1. **zbiera** publiczne ślady wyłącznie z dozwolonych źródeł i zabezpiecza każdą stronę jako dowód;
2. **wyodrębnia i weryfikuje** adresy kryptowalutowe (decydują sumy kontrolne, nie same wyrażenia regularne);
3. **ocenia** każde powiązanie tożsamość↔adres wyjaśnialnym, dwuetapowym Wskaźnikiem Pewności opartym na ilorazach
   wiarygodności;
4. **odrzuca błędne przypisania** (adresy giełd, portfeli powierniczych, smart kontraktów, instytucji), _przeklasyfikowując_
   je zamiast usuwać;
5. **analizuje aktywność on-chain**: wolumeny, wymiany, konwersję na stablecoiny i przesłanki wyjścia do walut
   tradycyjnych, wyceniane w PLN;
6. **cyklicznie powtarza analizy**, porównuje wyniki (np. podmianę adresu portfela w profilu) i
7. **raportuje**, ściśle rozdzielając fakty źródłowe, wyniki obliczeń i wnioski.

## Struktura repozytorium

```
apps/
  api/            API HTTP (Fastify) dla konsoli analityka
  worker/         procesy w tle na pg-boss i PUNKT SKŁADANIA ZALEŻNOŚCI
  web/            konsola analityka w React, interfejs po polsku
  fixture-site/   syntetyczna strona testowa z personą, warianty v1/v2
packages/
  core/           model domeny + porty (bez zależności uruchomieniowych)
  db/             migracje PostgreSQL, role append-only, zapytania
  http/           klient HTTP z kontrolą ruchu wychodzącego
  evidence/       magazyn plików, manifesty zabezpieczeń, znaczniki czasu, porównania
  address-extractor/  wykrywanie, weryfikacja i kontekst adresów, maskowanie sekretów
  collectors/     adaptery źródeł OSINT + planer pivotów
  chain-adapters/ dostawcy danych blockchain
  labels/         etykiety, klasyfikacja typu adresu, reguły odrzucania
  analytics/      wycena w PLN, aktywność, reguły wyjścia do fiat, przepływy
  scoring/        dwuetapowy Wskaźnik Pewności
  reporting/      model raportu, HTML/PDF, eksporty
  llm/            klient zgodny z OpenAI, prompty, dziennik wywołań
services/osint-py/  serwis w Pythonie: Maigret, socid-extractor, pyHanko
config/           sources.yaml (zgodność + lista dozwolonych hostów), wagi wskaźnika, zestawy reguł
infra/            skrypty inicjalizacji bazy danych
fixtures/         syntetyczne korpusy, nagrania odpowiedzi (kasety), etykiety demonstracyjne
docs/             architektura, decyzje (ADR), zgodność, metodyka
```

## Zasady zależności

```
                 ┌────────────── apps/worker (punkt składania zależności) ──────┐
                 │   wpina implementacje w porty z @olcys/core                  │
apps/api ──┐     ▼                                                              ▼
           ├──► packages/* ──► @olcys/core ◄── apps/web (tylko typy)
apps/web ──┘
```

- Każdy pakiet zależy **wyłącznie od `@olcys/core`** (oraz bibliotek zewnętrznych). Pakiet nigdy nie importuje
  implementacji innego pakietu; to, czego potrzebuje, otrzymuje przez porty (`EgressClient`, `BlobStore`,
  `ChainProvider`, `LabelLookup`, `FxRateSource`, `LlmClient`, …) wstrzykiwane w `RunContext` lub w konstruktorze.
  Wyjątek: `apps/worker` i `apps/api` importują pakiety, aby je połączyć.
- **Cały ruch sieciowy przechodzi przez `@olcys/http`** (`EgressClient`). Żadne `fetch`, `undici`, `axios`, `got`,
  nawigacja Playwright ani klient SDK nie mogą sięgać do sieci inaczej niż przez ten klient lub kontrolowaną przez
  niego trasę. Ruch Playwright jest przechwytywany i sprawdzany względem tej samej listy dozwolonych hostów.
- Reguła `import/no-cycle` w oxlint zgłasza błąd przy cyklicznych importach.

## Tryby pracy (`OLCYS_MODE`)

| Tryb      | Sieć                                                                                                                                                                                                 | Zastosowanie                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `offline` | brak internetu; strona testowa i usługi wewnętrzne (Gotenberg, osint-py, lokalny model) działają na żywo, pozostałe hosty — wyłącznie z nagrań (`fixtures/cassettes/<zestaw>`); brak nagrania = błąd | rozwój, testy, demonstracja                              |
| `replay`  | wszystko z nagrań (także strona testowa); usługi wewnętrzne na żywo                                                                                                                                  | deterministyczna demonstracja, CI, odtworzenie przebiegu |
| `live`    | prawdziwa sieć, ograniczona do listy hostów źródeł włączonych dla sprawy (`OLCYS_RECORD=1` nagrywa odpowiedzi)                                                                                       | rzeczywiste analizy                                      |

## Cykl życia przebiegu analizy

Każdy krok to osobny typ zadania pg-boss z kluczem idempotencji `(runId, krok, klucz obiektu)`:

```
run.start         migawka konfiguracji (skrót sources.yaml, wersje wag i reguł, wersja narzędzia, model) → AnalysisRun
pivot.plan        identyfikatory → zadania zbierania (zakres: źródła włączone dla sprawy, maxPivotDepth)
collect.source*   SourceCollector.collect → Capture + OnlineAccount + Observation
extract.capture*  Capture → ExtractionResult (AddressCandidate, SecretFinding)
pivot.expand      nowe konta/adresy → kolejne zadania zbierania (z limitem głębokości)
chain.fetch*      ChainProvider → AddressSummary, NormalizedTransfer, UtxoTransaction
labels.classify*  AddressTypeClassification, AddressLabel, ExclusionDecision (A1–A8)
analytics.compute ActivityIndicators, CashOutEvent (B1–B7), FlowEdge, Valuation (PLN, NBP)
score.links       EvidenceFeature → LinkAssessment (dwuetapowy iloraz wiarygodności)
diff.previous     ChangeEvent względem poprzedniego przebiegu (ADDED / REMOVED / VALUE_CHANGED / SCORE_CHANGED)
report.render     ReportModel → HTML → PDF/A (+ manifest, podpis, znacznik czasu RFC 3161)
run.finish        status succeeded | partial | failed
```

Przebieg **ponownej oceny** (`trigger: 'rescore'`) przetwarza zapisane zabezpieczenia wcześniejszego przebiegu nowymi
wersjami algorytmu lub reguł bez ponownego pobierania danych — pozwala to odróżnić zmianę danych od zmiany algorytmu.
Tylko ponowna ocena stosuje też korekty analityka zapisane do chwili jej zlecenia (zbiór ustalony przy zleceniu,
zapisany w migawce konfiguracji jako `analystOverrides` i `rulesVersions.overrides`); oceny analityka są zapisywane
obok wyników i nigdy ich nie zmieniają — zob. [metodyka Wskaźnika Pewności](methodology/wskaznik-pewnosci.md).

## Analizy okresowe (harmonogram)

Sprawa może mieć harmonogram ponownych analiz: wyrażenie cron (pięć pól: minuta, godzina, dzień miesiąca, miesiąc,
dzień tygodnia) liczone w UTC oraz flagę włączenia. Każdy przebieg z harmonogramu (`trigger: 'schedule'`) jest
porównywany z ostatnim zakończonym przebiegiem sprawy (`succeeded` lub `partial`, dowolnego rodzaju — także z ponowną
oceną), więc krok `diff.previous` pokazuje, co się zmieniło (np. podmianę adresu portfela). Przebieg z harmonogramu
zbiera dane od nowa i — jak każdy przebieg zbierający — nie stosuje korekt analityka; stosuje je tylko ponowna ocena
(zob. wyżej).

- **Planista w procesie API (MVP).** `createScheduler()` z `apps/worker` co `OLCYS_SCHEDULER_INTERVAL_SECONDS`
  (domyślnie 30 s) sprawdza otwarte sprawy z włączonym harmonogramem i obsługuje termin należny: najpóźniejszy termin
  cron do chwili bieżącej, późniejszy zarówno od ostatniej zmiany harmonogramu, jak i od ostatniego obsłużonego
  terminu. Stan planisty wynika wyłącznie z bazy danych; przy starcie `reconcile()` raportuje harmonogramy, terminy do
  nadrobienia i przebiegi w toku.
- **Idempotencja.** Każdy obsłużony termin to jeden wpis `schedule_tick` z unikalnym identyfikatorem zadania
  `<id sprawy>@<termin ISO>`. Wstawienie wpisu zajmuje termin: termin już obsłużony nigdy nie uruchamia drugiego
  przebiegu — także przy kilku procesach API korzystających z jednej bazy (blokada doradcza sprawy w transakcji, która
  zapisuje wpis razem z przebiegiem). Decyzja zapada pod tą blokadą na bieżącym stanie sprawy, a zmiana harmonogramu
  bierze tę samą blokadę: termin, który przestał być należny (harmonogram zmieniono po jego wyborze, termin nie pasuje
  do bieżącego wyrażenia albo obsłużono już późniejszy termin), nie jest obsługiwany i nie zostawia wpisu.
- **Bez nakładania się przebiegów.** Gdy przebieg sprawy jest w stanie `queued` lub `running`, termin jest pomijany
  (`skipped_overlap`); przy wyłączonym harmonogramie — `skipped_disabled`; w zamkniętej sprawie — `skipped_case_closed`.
- **Nadrabianie po przerwie.** Po przestoju uruchamiany jest najwyżej jeden przebieg — dla najpóźniejszego opuszczonego
  terminu; `fired_at` zapisuje faktyczny czas obsługi. Terminy sprzed zmiany harmonogramu (także z okresu, gdy był
  wyłączony) nie są nadrabiane.
- **Umiar wobec źródeł.** W trybie `live` odstęp między kolejnymi terminami musi wynosić co najmniej
  `OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES` (domyślnie 60 min), w trybach `offline` i `replay` — 1 min; jest sprawdzany
  dokładnie w obrębie doby i na przełomie dni, a dla wzorców dni (tygodnie, miesiące) na 10 najbliższych terminach.
  Harmonogram zapisany w innym trybie, zbyt częsty dla bieżącego, nie jest wykonywany. Przebiegi z harmonogramu
  podlegają tym samym ograniczeniom co ręczne (lista dozwolonych hostów, limity zapytań, zakres sprawy); harmonogram
  nigdy sam nie włącza źródeł.
- **Ewidencja.** `cases.schedule` to jedyna nowa wartość zmienna (prawo UPDATE wyłącznie do tej kolumny); każda zmiana
  trafia w tej samej transakcji do dopisywanego dziennika `case_schedule_change`: kto (z konfiguracji serwera:
  `OLCYS_ANALYST_NAME`, w razie braku `OLCYS_COLLECTOR_NAME`, domyślnie `analyst`; nigdy z żądania), dlaczego, wartość
  przed i po. Dla roli `olcys_app` tabele
  `case_schedule_change` i `schedule_tick` są tylko do dopisywania.
- **Odrzucane wyrażenia:** makra (`@daily`, `@reboot`), pole sekund, `H` (Jenkins), RRULE oraz jednoczesne ograniczenie
  dnia miesiąca i dnia tygodnia.

API: `GET`/`PUT /api/cases/:caseId/schedule` (zob. `apps/api/README.md`); w konsoli — panel „Harmonogram analiz” na
stronie sprawy. Demonstracja w trybie `offline`: harmonogram `*/2 * * * *`, a między wyzwoleniami przełączenie strony
testowej z wariantu v1 na v2 (`FIXTURE_ALLOW_VARIANT_SWITCH=1`, `POST /__fixture/variant`); drugi przebieg
z harmonogramu pokazuje alert podmiany portfela.

Ograniczenie MVP: przebieg przerwany restartem procesu API pozostaje w stanie `running`, więc kolejne terminy są
pomijane (`skipped_overlap`); raport startowy planisty i dziennik wskazują takie przebiegi.

## Dowody i pochodzenie danych

- Każda odpowiedź z zewnątrz otrzymuje `ProvenanceEnvelope` (dostawca, URL z zamaskowanymi sekretami, czasy, status,
  SHA-256 treści, tryb, wersja narzędzia, wierzchołek łańcucha dla danych blockchain) oraz wpis `EgressLogEntry`
  (host, cel, informacja, czy ujawniono identyfikator ze sprawy). Oba zapisy są tylko do dopisywania.
- Każda zebrana strona staje się rekordem `Capture` z polami Protokołu Berkeley (URL, źródło HTML, zrzut całej strony,
  osoba zbierająca, maszyna, czas zsynchronizowany z NTP, skrót w chwili zbierania), manifestem SHA-256 oraz
  znacznikiem czasu RFC 3161. Na zewnątrz wysyłane są wyłącznie skróty.
- Surowe bajty trafiają do magazynu adresowanego treścią: `${OLCYS_DATA_DIR}/blobs/sha256/<aa>/<bb>/<skrót>`.
- PostgreSQL jest systemem źródłowym. Rola aplikacji `olcys_app` ma na tabelach dowodowych tylko SELECT/INSERT
  (zob. `infra/postgres/init/01-roles.sh`); stan zmienny (status przebiegu, harmonogramy) ma jawne, opisane uprawnienia.

## Wskaźnik Pewności (podsumowanie)

Oceniane twierdzenie: `(tożsamość, adres, sieć, relacja)`. Dwa etapy, których prawdopodobieństwa się mnoży:

```
P(tożsamość↔adres | ścieżka) = P(tożsamość↔konto) × P(konto↔adres)
dla etapu:  W = log2(szanse a priori) + Σ log2(BF′),   BF′ = ρ·BF + (1 − ρ),   P = 2^W / (1 + 2^W)
ścieżki:    P = 1 − Π(1 − P_ścieżki)          wynik = round(100·P)   (pewność w skali STIX 2.1)
```

- Poziomy dowodów: **E1** wiązanie kryptograficzne · **E2** deklaracja z uwierzytelnionego konta · **E3** wzmianka
  w kontekście · **E4** przypisanie przez stronę trzecią (tylko potwierdza) · **AUTH** listy urzędowe (służą odrzucaniu).
- ρ wynika z oceny wiarygodności źródła w skali Admiralicji (A 0,95 … E 0,2; F wymaga oceny analityka).
- Liczy się tylko najsilniejsza przesłanka danej rodziny cech w grupie o wspólnym pochodzeniu (repostów i kopii nie
  liczy się podwójnie).
- Twarde bramki poza arytmetyką: błędna suma kontrolna → brak twierdzenia; reguły odrzucania → panel odrzuconych
  z uzasadnieniem; sugestie modelu językowego mają wagę 0, dopóki analityk ich nie potwierdzi.
- Wynik dla powiązania: wskaźnik 0–100, termin prawdopodobieństwa wg ICD 203, słowny odpowiednik ilorazu wiarygodności
  wg ENFSI dla każdego etapu, osobna pewność analityczna, pełna lista wkładów (wykres kaskadowy), `algorithmVersion`,
  `weightsVersion`, `weightsSha256`.
- Wagi: `config/scoring/weights.v1.yaml` (nieskalibrowane). Przykład do odtworzenia w testach: kotwica na
  forum w stylu Bitcointalk + podpisany wpis + pole profilu → **99**; konto w stylu Wykopu z tym samym nickiem i linkiem
  do kotwicy oraz „mój portfel” → **50**; konto w stylu GitHuba z tym samym nickiem i deklaracją Drips → **24**;
  ścieżki Wykop + GitHub łącznie → **62**.

## Odrzucanie błędnych przypisań i wyjście do walut tradycyjnych

Reguły odrzucania A1–A8 (`config/rules/exclusion.v1.yaml`) przeklasyfikowują zamiast usuwać: adres depozytowy giełdy
nie jest środkami badanej osoby, ale jej przelew na ten adres jest najsilniejszą dostępną w otwartych danych przesłanką
wyjścia do walut tradycyjnych (B1), a adres depozytowy, który osoba sama _opublikowała_, to trop KYC. Reguły B1–B7
(`config/rules/cashout.v1.yaml`) dają osobny wskaźnik wyjścia do fiat; wartości liczone są w PLN według kursu
średniego NBP (tabela A) z ostatniego dnia roboczego przed transakcją.

## AI (wymienny model)

`@olcys/llm` korzysta z API Chat Completions zgodnego z OpenAI, więc zmiana modelu sprowadza się do zmiany
`LLM_BASE_URL` i `LLM_MODEL` (domyślnie lokalnie: Ollama/llama.cpp/vLLM). Model jedynie _podpowiada_ (rola wzmianki
o adresie, odmiana polskich imion i nazwisk, szkice wniosków w raporcie); nigdy nie wyszukuje adresów i nie ustala
wyników, otrzymuje zebrany tekst wyłącznie jako oznaczone, niezaufane dane, nie ma dostępu do narzędzi, a każde
wywołanie jest rejestrowane (wersja promptu, model, skrót modelu, odpowiedź).

## Język interfejsu i dokumentacji

Konsola analityka, raporty, wszystkie pliki README oraz katalog `docs/` są **po polsku**. Wszystkie teksty widoczne dla
użytkownika pochodzą z `apps/web/src/i18n/pl.ts` (teksty raportów — z polskiego katalogu pakietu reporting). Kod,
identyfikatory, logi, komentarze i nazwy pól API pozostają w języku angielskim.
