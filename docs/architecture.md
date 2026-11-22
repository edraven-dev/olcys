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
llm.suggest       (tylko przy włączonym modelu) rola wzmianki o adresie → LlmSuggestion o wadze 0, w procesie, bez kolejki
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

## Oś czasu strony

Wartości strony lub pola profilu w czasie łączą przebiegi na żywo z kopiami archiwalnymi (Wayback Machine, tylko
odczyt). `buildPropertyTimelines` (`@olcys/evidence`) buduje `PropertyTimeline`: punkty (czas migawki z archiwum albo
czas przechwycenia), okresy o tym samym zbiorze wartości i zmiany z przedziałem „ostatni punkt przed — pierwszy po”.
Przechwycenie, z którego odkryto konto, reprezentuje kanoniczną stronę profilu tego konta (adres z rekordu konta, bez zgadywania po tekście adresu), więc profil pobrany po nicku i jego kopie archiwalne tworzą jedną oś. Punkt zachowuje pochodzenie (`archive` / `live`), więc raport i konsola oznaczają kopie archiwalne jako materiał strony
trzeciej. Luka (niepobrana kopia z nowym skrótem, skrót niezgodny, strona niedostępna lub 404 w kopii) nie kończy
okresu i nie tworzy zmiany; niepobrana kopia z tym samym skrótem CDX dziedziczy wartości (data przybliżona). Fakty
(wykaz migawek), obliczenia (zgodność skrótu) i wnioski pozostają rozdzielone. Dostęp: `GET /api/cases/:id/timeline`.

## Dowody i pochodzenie danych

- Każda odpowiedź z zewnątrz otrzymuje `ProvenanceEnvelope` (dostawca, URL z zamaskowanymi sekretami, czasy, status,
  SHA-256 treści, tryb, wersja narzędzia, wierzchołek łańcucha dla danych blockchain) oraz wpis `EgressLogEntry`
  (host, cel, informacja, czy ujawniono identyfikator ze sprawy). Oba zapisy są tylko do dopisywania.
- Każda zebrana strona staje się rekordem `Capture` z polami Protokołu Berkeley (URL, źródło HTML, zrzut całej strony,
  osoba zbierająca, maszyna, czas zsynchronizowany z NTP, skrót w chwili zbierania), manifestem SHA-256 oraz
  znacznikiem czasu RFC 3161. Na zewnątrz wysyłane są wyłącznie skróty.
- Surowe bajty trafiają do magazynu adresowanego treścią: `${OLCYS_DATA_DIR}/blobs/sha256/<aa>/<bb>/<skrót>`.
- **Manifest przechwycenia (Protokół Berkeley ¶155, formularz z Aneksu IV).** Jeden moduł, `CaptureRecorder`
  (`@olcys/evidence`), zamienia zebrane bajty w rekord dowodowy: zapisuje artefakty, buduje manifest w kanonicznym JSON
  (RFC 8785), zapisuje go jako plik w magazynie (`application/vnd.olcys.capture-manifest+json`), a jego skrót SHA-256 staje
  się `Capture.manifestSha256` — `blobs.get(manifestSha256)` zwraca dokładnie zhaszowane bajty. Kolektory nie liczą
  manifestów; tożsamość kolektora, stan zegara i wersję narzędzia ustawia wyłącznie rejestrator.

  | Protokół Berkeley                                                         | Pole manifestu                                                                                                                                                                                    |
  | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | ¶155(a) adres URL                                                         | `target.url`, `target.finalUrl`                                                                                                                                                                   |
  | ¶155(b) źródło HTML                                                       | artefakt `html` — treść odpowiedzi bajt w bajt (po ewentualnej redakcji sekretów, opisanej w `technical.redaction`)                                                                               |
  | ¶155(c) zrzut całej strony                                                | artefakt `screenshot` (patrz niżej: w tym wdrożeniu nie jest tworzony)                                                                                                                            |
  | ¶155(g) osoba zbierająca, adres IP maszyny, tożsamość wirtualna, czas NTP | `collector.name/host/ip/ipSource`, `collector.virtualIdentity` (zawsze `null`), `time.*` (`startedAt`/`endedAt` = czas rozpoczęcia i zakończenia z Aneksu IV, `time.clock` = stan synchronizacji) |
  | ¶155(h) skrót w chwili zbierania                                          | `artifacts[].sha256` oraz skrót samego manifestu                                                                                                                                                  |
  | Aneks IV: adres IP serwera                                                | `target.serverIp` (gdy znany)                                                                                                                                                                     |
  | Aneks IV: użyte usługi                                                    | `tools`, `userAgent`, `collector.ipSource`, `time.clock`                                                                                                                                          |
  | ¶154 przekształcenia                                                      | `transformations`                                                                                                                                                                                 |
  | ¶156 raport techniczny                                                    | sam manifest (`technical`: przekierowania, robots.txt, bariera, redakcja)                                                                                                                         |

  Kompletność: profil `web_page` wymaga `html` i `screenshot`, `api_response` — `headers` i jednego z `json`/`html`/`text`,
  `archive_snapshot` — `html`. Brakujące rodzaje trafiają do `completeness.missing`, a przechwycenie i tak jest zachowane.
  **Przechwytywanie w przeglądarce nie jest włączone**, więc każda strona WWW jest zapisywana bez zrzutu ekranu
  (`completeness.missing: ['screenshot']`); ostrzeżenie trafia do dziennika raz na przebieg, a aneks dowodowy raportu
  podaje tę informację po polsku. Typy `rendered_html` i `screenshot` istnieją w kontraktach na potrzeby przyszłego
  przechwytywania w przeglądarce.

- **Zegar.** Stan synchronizacji z NTP odczytywany jest wyłącznie z lokalnego stanu systemu (`chronyc -c tracking`, potem
  `timedatectl show -p NTPSynchronized`, potem plik `/run/systemd/timesync/synchronized`; bez powłoki, limit 2 s, pamięć
  podręczna 60 s) — nigdy z serwerów NTP, nagłówków `Date` ani usług zwracających adres IP. `Capture.clockSynced` jest
  prawdą, gdy zegar jest zsynchronizowany, a przesunięcie nie przekracza `OLCYS_CLOCK_MAX_OFFSET_MS` (domyślnie 1000).
  W kontenerze bez tych narzędzi wynik to `unknown` (`clockSynced: false`). Adres IP kolektora to `OLCYS_COLLECTOR_IP`
  (adres wyjściowy wdrożenia) albo pierwszy zewnętrzny adres IPv4 interfejsu.
- **Łańcuch dowodowy.** Każde zabezpieczenie zapisuje zdarzenie `collected` w tabeli `custody_event` (tylko do dopisywania:
  rola `olcys_app` ma SELECT/INSERT); lista zdarzeń przebiegu: `GET /api/runs/:runId/custody`. Manifest zawiera nazwę
  analityka i adres IP stanowiska — nie jest logowany, a paczki zabezpieczonego materiału należy traktować jako dane
  o ograniczonym dostępie.
- **Znaczniki czasu RFC 3161.** Po zapisaniu zabezpieczeń etap zbierania prosi usługę znakowania czasem (`TSA_URL`, w
  demonstracji FreeTSA, źródło `freetsa` z rejestru) o token dla skrótu manifestu (`manifestSha256`); poza system wychodzi
  tylko skrót i nonce, przez `EgressClient`. Token jest weryfikowany (status, odcisk, nonce, podpis, krytyczne EKU
  `timeStamping`, `ESSCertID`, łańcuch do kotwic z `config/tsa/`, ważność w chwili `genTime`), a cała odpowiedź zapisana
  w magazynie blobów (`application/timestamp-reply`) — można ją sprawdzić niezależnie poleceniem
  `openssl ts -verify` (zob. `config/tsa/freetsa/README.md`). Tylko tryb `live` łączy się z TSA; `offline`, `replay`
  i `TSA_ENABLED=false` zapisują żądanie ze stanem `queued` (bez zapytania sieciowego), a raport pokazuje
  „znacznik czasu oczekuje (tryb offline)”. Kolejki zadań nie ma: oczekujące i nieudane żądania ponawia funkcja
  `flush` — polecenie `pnpm --filter @olcys/worker tsa:flush` oraz zegar harmonogramu (co 10 minut, tylko w trybie live).
  Zapis jest tylko do dopisywania (`timestamp_request`, `timestamp_token`, migracja `0009`): żądanie nigdy nie zmienia
  stanu — ponowienie to nowy wiersz (`queued` → `failed` → `granted`/`rejected`), a token jest jeden na
  (rodzaj, identyfikator, skrót), więc powtórne `flush` jest idempotentne. „Oczekuje” znaczy: ostatnie żądanie jest
  `queued` lub `failed`, a tokenu nie ma; odpowiedź niezweryfikowana (`rejected`) nie jest ponawiana. Każda próba daje
  zdarzenie `timestamped` albo `timestamp_failed` w łańcuchu dowodowym; gdy czas `genTime` różni się od czasu
  zebrania o więcej niż `TSA_MAX_CLOCK_SKEW_SECONDS` (domyślnie 120), zdarzenie ma `skewSuspected: true`. Wczytując
  przechwycenie, repozytorium uzupełnia `Capture.timestamp`. Start procesu kończy się błędem
  `tsa_host_not_allow_listed`, gdy host z `TSA_URL` nie jest w `allowedHosts` źródła `TSA_SOURCE_ID`. FreeTSA jest usługą
  demonstracyjną, bez domniemania z art. 41 eIDAS; token nazywany jest „kwalifikowanym” dopiero po skonfigurowaniu
  kwalifikowanego dostawcy (`TSA_QUALIFIED=true`).
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
wyjścia do walut tradycyjnych (B1), a adres depozytowy, który osoba sama _opublikowała_, to trop KYC. Reguły A2/A3
opierają się na typie adresu ustalanym deterministycznymi odczytami stanu łańcucha (kod, slot Safe, `entryPoint()`,
sondy tokena; „stan na zapisany szczyt łańcucha”, zapis przy przebiegu): od EIP-7702 sam kod pod adresem nie oznacza
kontraktu usługi — konto EOA z delegacją, konto Safe i konto ERC-4337 mogą należeć do osoby. Reguły B1–B7
(`config/rules/cashout.v1.yaml`) dają osobny wskaźnik wyjścia do fiat; wartości liczone są w PLN według kursu
średniego NBP (tabela A) z ostatniego dnia roboczego przed transakcją.

## AI (wymienny model)

`@olcys/llm` korzysta z API Chat Completions zgodnego z OpenAI, więc zmiana modelu sprowadza się do zmiany
`LLM_BASE_URL` i `LLM_MODEL`. Domyślnie jest to lokalny OpenVINO Model Server (`http://localhost:2140/v3`, model
`qwen3.6-35b-ov`, myślenie wyłączone przez `LLM_CHAT_TEMPLATE_KWARGS`); Ollama, llama.cpp i vLLM działają tak samo.
Punkt końcowy modelu jest źródłem w `config/sources.yaml` (`local_llm`, rodzaj `ai_model`, nie wysyła identyfikatorów
poza maszynę), a cały ruch idzie przez `@olcys/http`: lista dozwolonych hostów, limit zapytań, dziennik wyjścia
(`containsIdentifier`) i koperta pochodzenia. Zdalny punkt końcowy wymaga własnego wpisu AMBER i zgody w sprawie.

Model jedynie _podpowiada_ (rola wzmianki o adresie, odmiana polskich imion i nazwisk, szkice wniosków w raporcie);
nigdy nie wyszukuje adresów i nie ustala wyników. Zebrany tekst trafia do niego wyłącznie jako niezaufane dane między
znacznikami z jednorazowym, deterministycznym znacznikiem (tekst jest normalizowany, znaki niewidoczne i fałszywe
znaczniki usuwane); żądanie nie zawiera narzędzi. Treści ze źródeł z `llmAllowed: false` (np. Telegram) nigdy nie
trafiają do promptu, a zbyt długi tekst jest odrzucany. Odpowiedź musi spełniać schemat JSON; wyniki oczekiwane
(`disabled`, `input_rejected`, `egress_denied`, `timeout`, `http_error`, `invalid_json`, `schema_violation`) są
zwracane jako wartości, a każda próba trafia do dziennika `llm_call` (wersja i skrót promptu, model żądany i zgłoszony,
skrót modelu, parametry, skrót i blob żądania, blob odpowiedzi). Prompty są wersjonowane i zablokowane skrótem w
`packages/llm/prompts.lock.json`.

Sugestie (`llm_suggestion`) mają zerową wagę w ocenie, dopóki analityk ich nie potwierdzi decyzją z uzasadnieniem
(`POST /api/suggestions/:id/decision`, jedna decyzja na sugestię); potwierdzenie niczego nie zmienia w zapisanej
ocenie, a uwzględnia je dopiero kolejny przebieg ponownej oceny (potwierdzona rola wzmianki trafia wtedy jako sygnał
`AnalystCue` do punktu wejścia oceny; oczekujące i odrzucone sugestie nigdy). Krok `llm.suggest` nigdy nie kończy
przebiegu błędem: niedostępny lub zawodzący model daje kod `llm_unavailable` (przebieg `partial`), a po 3 kolejnych
niepowodzeniach kolejne wzmianki nie są wysyłane. Decyzja o sugestii zleca w tle ponowne wygenerowanie raportu przebiegu (nowa wersja, wcześniejsze zostają); odpowiedź nie czeka na renderowanie. Tekst z Telegrama nie trafia do modelu. Fakty, wyniki obliczeń i wnioski pozostają rozdzielone.

## Bezpieczeństwo

Nagłówki i CSP, dziennik dostępu (tabela `access_log`, tylko dopisywanie), brak telemetrii, sekrety wyłącznie ze
środowiska i utwardzone kontenery opisuje `docs/security.md`. Konta i logowanie są poza zakresem MVP (planowane później).

## Język interfejsu i dokumentacji

Konsola analityka, raporty, wszystkie pliki README oraz katalog `docs/` są **po polsku**. Wszystkie teksty widoczne dla
użytkownika pochodzą z `apps/web/src/i18n/pl.ts` (teksty raportów — z polskiego katalogu pakietu reporting). Kod,
identyfikatory, logi, komentarze i nazwy pól API pozostają w języku angielskim.
