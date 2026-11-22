# @olcys/collectors

Kolektory źródeł OSINT za portem `SourceCollector` oraz planer rozwijania wyszukiwania (pivotów): z identyfikatorów
sprawy wyszukuje publiczne ślady (także przez wyszukiwarki internetowe), zapisuje każdą pobraną stronę jako
przechwycenie (dowód) i odczytuje z niej fakty (obserwacje). Adresów kryptowalut w tekście nie wyszukuje — robi to
ekstraktor adresów na zapisanym HTML.

- **Zależności:** kontrakty `@olcys/core`; `linkedom` (parsowanie HTML), `yaml` (rejestr źródeł). Sieć wyłącznie
  przez wstrzyknięty `EgressClient` (`@olcys/http`), robots.txt przez wstrzyknięty `RobotsCache`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/collectors` (strona testowa
  uruchamiana w procesie na wolnym porcie, prawdziwy klient egress, bez dostępu do internetu).

## Zasady

1. **Zakres sprawy jest zamknięty:** źródła RED nigdy nie są kontaktowane, AMBER tylko z uzasadnieniem w sprawie
   (co najmniej 20 znaków), GREEN — gdy sprawa je wymienia. W trybach `offline` i `replay` dochodzi strona testowa (`fixture_site`).
   Kolektor spoza zakresu to błąd planera: `SourceRefusedError` przed jakimkolwiek żądaniem.
2. **Każde żądanie** idzie przez klienta egress (lista dozwolonych hostów, limity, dziennik z `containsIdentifier`,
   koperta pochodzenia). `containsIdentifier` nigdy nie jest obniżane, a identyfikator sprawy w adresie podnosi je do
   `true`. W trybie `live` żądanie z syntetycznym identyfikatorem persony jest odrzucane przed wysłaniem.
3. **robots.txt (RFC 9309) dla każdego kroku**, przekierowania obsługiwane ręcznie (najwyżej 5), host każdego kroku
   sprawdzany względem listy dozwolonych. Strona wyłączona w robots.txt nie jest pobierana.
4. **Bariery kończą zbieranie ze źródła:** CAPTCHA, wyzwanie przeglądarki (`cf-mitigated: challenge`), ściana
   logowania, blokada (403/451) i limit (429 z `retry-after`) dają status `captcha` / `login_wall` / `blocked`, strona
   blokady zostaje zapisana jako dowód, a źródło do końca przebiegu nie jest już odpytywane. Bez ponowień i obchodzenia.
5. **Tryby `offline` i `replay`:** kolektory budują adresy prawdziwych serwisów, a `resolveSourceUrl` zamienia host na prefiks
   strony testowej (`hostPrefixes` z manifestu persony, adres bazowy `OLCYS_FIXTURE_BASE_URL` lub `FIXTURE_SITE_URL`).
   W `replay` adresy, kolektory i lista obserwowanych stron są takie same jak w `offline`, więc klucze nagrań się
   zgadzają. Lokalizatory nie zależą od hosta, więc przebieg offline i live daje te same obserwacje.
6. **Treść stron to dane, nie polecenia.** Parsery są czyste: ponowne przetworzenie zapisanego HTML daje te same fakty.
7. **Sekrety nie trafiają do magazynu:** treść strony jest pobierana z `persistBody: false` (klient egress zachowuje
   tylko skrót i jej nie nagrywa), w pamięci przechodzi przez `SecretRedactor` (klucze prywatne, frazy seed), a
   zapisywane są wyłącznie bajty po redakcji. Parsery i obserwacje widzą tylko tekst po redakcji; `technical.redaction`
   podaje liczbę i rodzaje usuniętych sekretów (bez wartości) oraz skrót oryginału z koperty pochodzenia.

## Publiczne API (wywołanie z pipeline’u)

```ts
const sources = await loadSourceRegistry(); // config/sources.yaml (albo createSourceRegistry(descriptors))
const scope = sources.resolveScope(kase.scope, mode); // enabled, refused, amberJustifications, egressSources
const http = createEgressClient({
  mode,
  runId,
  enabledSources: scope.egressSources,
  blobs,
  sinks,
  toolVersion,
  userAgent,
});
const robots = new RobotsCache(http, userAgent);
const config = await loadCollectorConfig({ mode, env: process.env }); // manifest persony, jeśli istnieje
const result = await collectCase({
  identifiers: kase.identifiers,
  scope,
  sources,
  ctx: { runId, caseId, mode, http, blobs, clock, logger },
  config,
  robots,
  redactor, // SecretRedactor z ekstraktora adresów (wymagany)
  maxPivotDepth: kase.scope.maxPivotDepth,
  onTask: ({ done, planned }) => progress({ done, planned }), // opcjonalnie
});
// result: captures, accounts, observations (do zapisania), tasks + skipped (plan z powodami),
// sources (wynik per źródło: ok | partial | not_found | blocked | login_wall | captcha | error), partial
```

- `redHosts: redBlockedHosts(sources.list())` w opcjach klienta egress: hosty źródeł RED z rejestru są odrzucane zawsze.
- `scope.egressSources` — deskryptory dla klienta egress; offline każde źródło dostaje limit strony testowej.
- `createDefaultCollectorRegistry({ mode, env })` — kolektory poniżej oraz wyszukiwarki według `OLCYS_SEARCH_MODE`
  (`collectCase` bez `collectors` buduje go z trybu przebiegu i opcji `env`; bez `env` — wyszukiwarka testowa);
  `runCollector()` uruchamia jeden kolektor w zakresie; `isSearchResultCapture()` rozpoznaje przechwycenia list wyników.
- Elementy do ponownego użycia: `fetchPage`, `detectAccessBarrier`, `toFixtureUrl` / `toLogicalUrl` /
  `recogniseAccountUrl`, `ResultBuilder`, `buildCapture`, `rollupStatus`, parsery stron.

Kolektory nie liczą manifestów: `buildCapture` przekazuje szkic do `ctx.evidence` (`CaptureRecorder` z `@olcys/evidence`),
który zapisuje artefakty i manifest oraz ustawia tożsamość kolektora, stan zegara (`OLCYS_COLLECTOR_NAME`,
`OLCYS_COLLECTOR_IP`, `OLCYS_CLOCK_MAX_OFFSET_MS`) i wersję narzędzia. Strony WWW zbierane bez przeglądarki nie mają zrzutu
ekranu (`completeness.missing: ['screenshot']`).

Przechwycenie (`Capture`): adres pobrany i końcowy, czas, kolektor, wersja narzędzia, user agent, status HTTP i status
zbierania, artefakty `html`/`json`/`text` (bajty jak odebrane albo — gdy usunięto sekrety — tekst po redakcji w UTF-8; skrót
oryginału zostaje w kopercie pochodzenia i w `technical.redaction`) oraz `headers` (kanoniczny JSON), identyfikatory pobrań całego łańcucha przekierowań,
`manifestSha256` (skrót pliku manifestu w magazynie) oraz `technical` (adres logiczny, przekierowania, decyzja robots.txt, sygnały bariery, redakcja, wersje parserów).

## Rejestr zgodności (`src/compliance`)

Rejestr `config/sources.yaml` jest jedynym źródłem prawdy o zgodności źródeł. Każdy wpis wymaga `namePl`, `complianceNotePl`
i klucza `tosUrl` (`null` = brak opublikowanego regulaminu); źródło RED ma `enabledByDefault: false`, `rateLimit.requests: 0`,
puste `allowedHosts` i niepuste `blockedHosts`, źródło AMBER — `enabledByDefault: false`; identyfikatory są unikalne w obu
sekcjach.

- `loadSourceRegister(path?)` / `createSourceRegister(descriptors)` — rejestr (`version`, `sha256`, `entries`).
- `validateCaseScope(scope, register)` — lista naruszeń zakresu sprawy (`source_forbidden`, `unknown_source`,
  `amber_justification_required`, `justification_too_short`, `orphan_justification`, `pivot_depth_out_of_range`,
  `unknown_chain`); używa jej `POST /api/cases`.
- `allowListFor(register, scope, mode, extraHosts?)` — lista hostów dla sprawy: offline tylko strona testowa; live i replay —
  suma hostów włączonych źródeł (AMBER tylko z uzasadnieniem) i `extraHosts`, bez hostów źródeł RED i ich subdomen.
- `assertCollectorAllowed(descriptor, register)` — rzuca `SourceForbiddenError` dla RED i `SourceDescriptorMismatchError`, gdy
  deskryptor kolektora różni się od wpisu rejestru; `CollectorRegistry.forScope` wywołuje ją przy tworzeniu kolektorów.
- `config/forbidden-tools.yaml` — narzędzia niedozwolone (powód po polsku i angielsku, pakiety npm/pypi/obrazy);
  `scanForbiddenDependencies()` sprawdza manifesty pakietów, `pyproject.toml`/`uv.lock`, pliki compose i Dockerfile
  (test `forbidden-tools.test.ts`).
- `pnpm compliance:sources` (`scripts/sources-doc.ts --check`, część `pnpm check`) sprawdza, czy tabele w
  `docs/compliance/sources.md` odpowiadają rejestrowi; `node packages/collectors/scripts/sources-doc.ts --write` je
  regeneruje (tylko blok między znacznikami `generated:sources`). Opcje: `--lang pl|en`, `--out <plik>` (angielskie
  zestawienie wymaga `--out`).

## Kolektory

| Źródło (`sourceId`) | Platforma       | Tryby         | Co zbiera                                                                                                            |
| ------------------- | --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bitcointalk`       | `bitcointalk`   | offline, live | profil → „Show Posts” → do 3 wątków (najpierw z podpisaną wiadomością, potem z adresem)                              |
| `wykop`             | `wykop`         | offline       | profil społecznościowy: opis, linki do innych kont (`account.link`), wpisy                                           |
| `github`            | `github`        | offline       | profil z tym samym nickiem → repozytoria → surowy `FUNDING.json` (roszczenia Drips)                                  |
| `telegram_preview`  | `telegram`      | offline, live | publiczny podgląd kanału `t.me/s/<kanał>`: opis kanału, posty z autorem (strona trzecia)                             |
| `fixture_site`      | `tablica`       | offline       | ogłoszenie P2P: sprzedający (imię i nazwisko, login, e-mail), treść ogłoszenia                                       |
| `mock_search`       | `web_search`    | offline       | wyszukiwarka testowa: strony z mapy witryny strony testowej zawierające zapytanie                                    |
| `brave_search`      | `web_search`    | live, replay  | Brave Search API: wyniki wyszukiwania dokładnej frazy (tylko w trybie `external`)                                    |
| `mojeek_search`     | `web_search`    | live, replay  | Mojeek Search API: wyniki wyszukiwania dokładnej frazy (tylko w trybie `external`)                                   |
| `ceidg`             | `ceidg`         | offline, live | CEIDG API v3: firmy jednoosobowe po imieniu i nazwisku (w `live` wymaga tokenu)                                      |
| `vat_whitelist`     | `vat_whitelist` | offline, live | wykaz podatników VAT po NIP lub REGON: status VAT, rachunki bankowe, osoby (nazwa i rola)                            |
| `krs`               | `krs`           | offline, live | KRS Open API: odpis aktualny spółki po numerze KRS (zarząd, prokurenci, wspólnicy)                                   |
| `wayback_cdx`       | `wayback`       | offline, live | historia profilu w Wayback Machine (tylko odczyt; sekcja „Historia z archiwum”)                                      |
| `maigret`           | `maigret`       | offline, live | enumeracja nicku w publicznych serwisach przez `services/osint-py` (sekcja „Enumeracja nicków”)                      |
| `keybase`           | `keybase`       | offline, live | publiczne `user/lookup`: podpisane adresy, zweryfikowane dowody kont (sekcja „Wyszukiwania tożsamości”)              |
| `bitlist`           | `bitlist`       | offline, live | archiwum Bitcointalk (BitList): nick → adresy i wpisy, adres → autorzy (AMBER, sekcja „Wyszukiwania tożsamości”)     |
| `ens`               | `ens`           | offline, live | ENS: nazwa główna zweryfikowana „w przód”, rekordy tekstowe i adresy innych sieci (sekcja „Wyszukiwania tożsamości”) |

Profil forum po nazwie (`action=profile;user=`) jest sprawdzony tylko na stronie testowej; w trybie `live` potrzebny
jest numer uid albo adres profilu. Strony Wykopu, GitHuba (HTML) i ogłoszeń istnieją tylko na stronie testowej.
Wyszukiwarka testowa działa w trybach `offline` i `replay` (w `live` zadanie jest pomijane jako `unsupported`).

## Rejestry publiczne (`registry.*`)

Trzy oficjalne rejestry dają legalne powiązania imię i nazwisko → firma → rachunek bankowy, które łączą wypłatę z
łańcucha z obiegiem fiat. Fakty rejestrowe są wiarygodne (A), ale **nie mają poziomu adresowego** (E1–E4) i nie zmieniają
Wskaźnika Pewności adresów; służą korroboracji tożsamości i kontekstowi fiat. Moduły: `src/registries/`.

| Źródło          | Zapytanie                                                                                                         | Dane wejściowe                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ceidg`         | `GET …/firmy?imie[]=…&nazwisko[]=…&page=1&limit=25` (nagłówek `Authorization: Bearer`); opcjonalnie `/firma/{id}` | identyfikator `full_name` (imię i nazwisko), wartość `nip` |
| `vat_whitelist` | `GET https://wykazpodatnikowvat.mf.gov.pl/api/search/nip/{nip}?date=RRRR-MM-DD` (także `regon`)                   | wartości `nip` / `regon` o poprawnej sumie kontrolnej      |
| `krs`           | `GET …/OdpisAktualny/{krs}?rejestr=P&format=json`, po 404 jednorazowo `rejestr=S`                                 | wartość `krs` (uzupełniana zerami do 10 cyfr)              |

- **CEIDG** wymaga własnego tokenu instytucji (`CEIDG_API_TOKEN`, wniosek na koncie Biznes.gov.pl). Token jest potrzebny
  tylko w trybie `live`: bez niego worker w ogóle nie rejestruje `ceidg` (planer widzi źródło jako niedostępne). W trybach
  `offline` i `replay` żądania idą do strony testowej z danymi syntetycznymi i nie mają nagłówka `Authorization`. Token
  trafia wyłącznie do nagłówka (`secretParams`), więc nie występuje w dzienniku ruchu, kopercie pochodzenia, adresie ani
  nagraniu. Limit: 1 żądanie / 4 s (publikowane limity: 50 / 3 min i 1000 / h). Wyszukiwanie po imieniu i nazwisku
  zwraca wszystkie osoby o tych danych, dlatego kolektor zapisuje liczbę trafień (`registry.ceidg.result_count`).
  Jedno słowo nie wystarcza (`supports()` fałsz); imię to pierwsze, nazwisko ostatnie słowo (nazwisko dwuczłonowe zostaje
  w całości), formy fleksyjne nie są normalizowane. HTTP 204 lub pusta lista to `not_found`. Dane kontaktowe z `/firma/{id}`
  (e-mail i strona WWW firmy; telefonu nigdy) czyta tylko opcja `fetchDetails` przy jednym trafieniu — domyślnie wyłączona.
- **Wykaz podatników VAT** nie wymaga klucza. Parametr `date` to data w strefie Europe/Warsaw (`warsawDate`), a nie UTC.
  Stary host `wl-api.mf.gov.pl` (wyłączany 2026-12-01) nie jest nigdzie używany. Limit wyszukiwania to 100 zapytań dziennie:
  przebieg wykonuje najwyżej 10 (`maxSearchCallsPerRun`), dalsze wartości są pomijane z notatką `truncated`; HTTP 429 lub
  błąd z komunikatem o limicie to `blocked` z notatką `rate_limited`, bez ponowień i bez kolejnych żądań. `requestId` z odpowiedzi
  jest urzędowym dowodem sprawdzenia i zostaje obserwacją `registry.vat_request_id`. Rachunki bankowe są zapisywane tylko
  po sprawdzeniu sumy kontrolnej NRB (IBAN mod 97). Adres zamieszkania (`residenceAddress`) bywa adresem domowym
  przedsiębiorcy, dlatego jest czytany tylko dla podmiotu z numerem KRS; w pozostałych przypadkach — wyłącznie adres
  prowadzenia działalności (`workingAddress`).
- **KRS** nie wymaga klucza (dane otwarte, CC0) i wyszukuje wyłącznie po numerze KRS. API bywa przerwane stroną HTML
  „Przerwa techniczna” z kodem 200 — kolektor zwraca wtedy `error` z notatką `KRS API maintenance` (nie „brak wpisu”) i
  nie próbuje drugiego rejestru.

**Minimalizacja danych.** Pola PESEL (biała lista, identyfikatory osób w KRS) nie są czytane — nie powstaje żadna
obserwacja z numerem PESEL. Osoby trzecie (reprezentanci, prokurenci, wspólnicy, członkowie zarządu) zapisywane są
wyłącznie jako nazwa i rola (`registry.representative`, `registry.partner`, wartość `<nazwa> — <rola>`) i **nigdy nie są
pivotami**. Odpowiedź rejestru jest zapisana jako przechwycenie (dowód), ale przed zapisem wartość każdego klucza `pesel` (na dowolnej
głębokości, także u reprezentantów, prokurentów i wspólników) jest zastępowana przez `null`; liczba usuniętych wartości
trafia do `technical.transformations`, a skrót oryginału zostaje w kopercie pochodzenia i w `technical.redaction`. Każde zapytanie ma `containsIdentifier: true` (imię, nazwisko i numery podatkowe to
identyfikatory sprawy). W trybie `live` imię i nazwisko będące syntetycznym identyfikatorem persony nie jest wysyłane.

**Obserwacje** (podmiot `ceidg:<id>` / `vat:<nip>` / `krs:<numer>` / `ceidg-search:<sha256 „imię nazwisko”>`; lokalizator
`<podmiot>#<ścieżka pola w odpowiedzi>`): `registry.business_name`, `.owner_name`, `.nip`, `.regon`, `.krs`, `.status`,
`.vat_status`, `.business_location` (adres siedziby lub działalności — celowo nie `registry.address`, żeby adres pocztowy
nigdy nie wyglądał na adres kryptowaluty), `.www`, `.email`, `.bank_account` (po jednej na rachunek), `.has_virtual_accounts`,
`.start_date`, `.removal_date`, `.vat_request_id`, `.representative`, `.partner` oraz `registry.ceidg.result_count`.
Etykiety polskie: `apps/web/src/i18n/pl.ts` i katalog pakietu raportu.

**Ograniczenie odtwarzania:** kolektory zapisują tylko treść po redakcji i wysyłają żądania z `persistBody: false`, więc `OLCYS_RECORD` nie nagrywa ich odpowiedzi. Odtwarzanie (`replay`) żądań kolektorów wymaga ręcznie przygotowanych, syntetycznych nagrań, a demonstracja offline obsługuje stronę testową na żywo.

**Kształty odpowiedzi** (`test/fixtures/registries/` i strona testowa, ścieżki `/registries/…`) odpowiadają
dokumentacji (CEIDG v3: `firmy[]`, `count`; biała lista: `result.subject`, `result.requestId`; KRS:
`odpis.naglowekA`, `odpis.dane.dzial1/dzial2`). Nazwy pól i parametrów zostały przyjęte ze streszczenia dokumentacji i
nie były sprawdzane na żywo — przed pierwszym użyciem produkcyjnym należy je zweryfikować w aktualnej dokumentacji
(zwłaszcza `nip[]` w CEIDG oraz kod błędu limitu na białej liście). Wartości w danych testowych są celowo nieprzydzielone:
NIP `0001234562`, REGON `001234562`, KRS `0009999901`, rachunki z numerem rozliczeniowym `00000000` (sumy kontrolne
liczy `buildNrb`), PESEL zawsze `null`.

## Wyszukiwarki (`search.v1`)

**Tryby (`OLCYS_SEARCH_MODE`):** `off` — żadna wyszukiwarka nie jest rejestrowana; `mock` (domyślnie) — tylko
wyszukiwarka testowa `mock_search`; `external` — dodatkowo Brave (`brave_search`) i Mojeek (`mojeek_search`), wyłącznie
w przebiegach `live` i `replay` i tylko z ustawionym kluczem (`BRAVE_SEARCH_API_KEY`, `MOJEEK_API_KEY`). Wyszukiwarka
testowa nigdy nie przełącza się na zewnętrzną. Nieznana wartość trybu to błąd konfiguracji. Każde źródło musi też być
włączone w sprawie: `mock_search` jest GREEN (domyślnie zaznaczone dla nowej sprawy), Brave i Mojeek są AMBER (z
uzasadnieniem), a zapytanie do nich ujawnia identyfikator (`containsIdentifier: true` w dzienniku ruchu).

**Zapytanie:** jedno na zadanie, z jednego podmiotu — identyfikatora (`full_name`, `nickname`, `email`,
`crypto_address`), adresu albo nicku; NFKC, odstępy scalone. Dokładna fraza `"…"` (`exactPhrase`): bez `"` w środku,
najwyżej 600 znaków i 75 słów.

**Wyszukiwarka testowa:** pobiera `/sitemap.xml` strony testowej (adresy `<loc>` względne są rozwiązywane względem
adresu mapy, także ze ścieżką bazową; adresy z innego originu są pomijane), a potem — raz na przebieg — każdą stronę
dozwoloną w robots.txt (`/private/` nigdy). Zapytania dopasowuje lokalnie, więc żaden
identyfikator nie opuszcza procesu: żądania są takie same bez względu na zapytanie (`containsIdentifier: false`).
Indeks: tekst bez `<script>` i `<style>`, encje zdekodowane, NFKC, odstępy scalone, sekrety usunięte przed
indeksowaniem. Fraza dokładna pasuje bez względu na wielkość liter i jako całe słowa (bez litery, cyfry ani `_` tuż
przed nią i po niej), zapytanie niedokładne — gdy każde jego słowo występuje jako całe słowo. Kolejność: liczba
wystąpień malejąco, potem adres; fragment ±80 znaków wokół pierwszego trafienia, tytuł z `<title>`, `fetchId` — pobranie
tej strony. Wyniki podają adres logiczny (jak obserwacje kolektorów). Treść stron jest pobierana tylko jako skrót
(`persistBody: false`) — kopię dowodową strony robi jej kolektor, po redakcji sekretów. Dlatego, tak jak kolektory
stron, w trybie `replay` wyszukiwarka testowa potrzebuje nagrań mapy witryny i stron testowych przygotowanych poza
klientem egress (`OLCYS_RECORD` nie nagrywa żądań tylko ze skrótem); brak nagrania to notatka `replay_miss` i status
`error` lub `partial`.

**Brave:** `GET https://api.search.brave.com/res/v1/web/search` z `q="…"`, `count=20`, `offset=0`, `safesearch=off`,
`spellcheck=false`, `text_decorations=false`, `result_filter=web`; dla imion i nazwisk oraz nicków `country=PL` i
`search_lang=pl`, dla e-maili i adresów kryptowalut `country=ALL`. Token w nagłówku `X-Subscription-Token` nie trafia do
dziennika, koperty pochodzenia ani nagrania. Gdy dostawca zmienił zapytanie (`query.altered`), wyniki są odrzucane
(status `partial`, dokładność nie jest zapewniona); 401/403 (klucz lub plan) i 422 → `error`; 429 → `blocked`, a źródło
jest wstrzymane do końca przebiegu (bez ponowień).

**Mojeek:** `GET https://api.mojeek.com/search` z `q="…"`, `fmt=json`, `t=20`, `s=1`, `api_key=…` (dla imion i nazwisk
oraz nicków `lb=PL`, `rb=PL`); klucz jest maskowany jako `api_key=REDACTED`; `response.status` inne niż `OK` → `error`.
Nazwy parametrów i pól odpowiedzi (`response.results[] { url, title, desc }`) należy sprawdzić w aktualnej dokumentacji
API Mojeek przed pierwszym użyciem na żywo; testy używają ręcznie przygotowanych odpowiedzi w tym kształcie.

**Przechowywanie wyników (warunki dostawców):** każde żądanie do dostawcy ma `persistBody: false` — surowa odpowiedź
nie trafia do magazynu ani nagrań (w kopercie pochodzenia tylko skrót i rozmiar, `bodyPersisted: false`), bo jej
fragmenty to tekst ze stron, który może zawierać sekrety. Warunki dostawców decydują, co zostaje w przechwyceniu:
wyszukiwarka testowa — pozycja, adres, tytuł i fragment (po redakcji sekretów); Brave — to samo tylko z
`BRAVE_SEARCH_STORAGE_RIGHTS=true` (plan niestandardowy: w FAQ Brave „Yes, with a custom plan”, a warunki API według
dostępnych opisów w innych planach na to nie pozwalają); Mojeek — w planie innym niż `startup` (`MOJEEK_PLAN`; plan
Startup pozwala buforować wyniki najwyżej godzinę). Bez prawa do przechowywania przechwycenie zawiera tylko
`{ rank, url }` każdego wyniku — bez tytułów i fragmentów — z notatką `search_results_not_stored`. Odpowiedzi nie są
nagrywane, więc przebieg `replay` odtwarza zapytania do Brave i Mojeek tylko z ręcznie przygotowanych, syntetycznych
nagrań (testy). **Otwarte pytanie prawne:** czy sama lista adresów wyników (przechwycenie i obserwacje
`search.result_url`) jako ślad audytowy mieści się w warunkach Brave i Mojeek — do potwierdzenia przed użyciem
produkcyjnym.

**Przechwycenie:** kanoniczny JSON `{ schema: 'olcys.search-results.v1', provider, query, exact, subject, maxResults,
retrievedAt, storage, status, results }`; adres — żądanie do dostawcy (dla wyszukiwarki testowej: mapa witryny);
`fetchIds` — wszystkie żądania, na których opiera się wynik. Status: `ok` (co najmniej 1 wynik), `not_found` (0
wyników), `error` (błąd, zmienione zapytanie albo niepełny indeks — brak wyniku nie dowodzi nieobecności), `blocked`.
**Lista wyników nie jest dowodem:** etap wyodrębniania adresów pomija przechwycenia wyszukiwarek, a strony z wyników
zbierają ich własne kolektory (reguła E3) — raz, niezależnie od tego, czy trafiono na nie bezpośrednio, czy przez
wyszukiwarkę.

## Historia z archiwum (Wayback Machine)

Kolektor `wayback_cdx` (`src/wayback`) odpowiada na pytanie „co profil pokazywał, zanim zaczęliśmy go obserwować”, czyli
pozwala wykryć zmianę portfela, która nastąpiła przed pierwszym przebiegiem. Działa wyłącznie w trybie odczytu:

1. **Availability API** (`archive.org/wayback/available?url=…`): brak `archived_snapshots.closest` oznacza `not_found`
   po jednym zapytaniu.
2. **CDX** (`web.archive.org/cdx/search/cdx`, parametry w stałej kolejności: `url`, `output=json`, `fl`,
   `filter=statuscode:200`, `collapse=digest`, `limit=500`, `showResumeKey=true`, opcjonalnie `from`) wylicza tylko
   przechwycenia, w których treść się zmieniła. Kolejne strony wyników pobierane są kluczem wznowienia, do
   `maxCdxPages` (domyślnie 3). Zbiegają się tylko sąsiednie, identyczne skróty, więc A → B → A to trzy wpisy — i to jest
   oś czasu.
3. **Wybór snapshotów** (`selectSnapshots`): do `maxSnapshotsPerUrl` (domyślnie 12) — pierwsza, ostatnia i równomiernie
   rozłożone pozostałe; rosnąco i deterministycznie.
4. **Pobranie surowego snapshotu** (`…/web/<znacznik>id_/<adres>`): bajty archiwum bez przepisywania przez Wayback. Skrót
   SHA-1 (base32, bez dopełnienia) porównywany jest ze skrótem z CDX; wynik (`match` / `mismatch`) jest tylko
   zapisywany, bo ponowne kodowanie przy transferze może dać niezgodność.

Zasady:

- **Save Page Now nigdy nie jest używane** — publikuje przechwycenie strony podejrzanej i ujawnia zainteresowanie
  śledczych. `assertWaybackReadUrl` (`guard.ts`) odrzuca każdy adres punktu zapisu archiwum i dopuszcza na hostach
  archiwum wyłącznie punkty odczytu (CDX, Availability, odtwarzanie); wysyłane jest wyłącznie `GET`. Test sprawdza też, że
  żaden plik `src/wayback` nie zawiera ścieżki tego punktu.
- Jedno zapytanie naraz, do 20 na minutę łącznie dla obu hostów źródła (`config/sources.yaml`; klient wyjściowy limituje teraz także na źródło, nie tylko na host). Odpowiedź 429, która
  utrzymuje się po odczekaniu klienta, otwiera **obwód na resztę przebiegu** (wspólny dla wszystkich zadań Wayback tego
  przebiegu): kolejne zadania nie wysyłają nic i kończą się `blocked`, bieżące — `partial` (albo `blocked`) z notatką
  `rate_limited: wayback rate limited (circuit open)`. Odpowiedź 5xx kończy tylko to jedno zapytanie (`error`).
- Każde zapytanie ma `containsIdentifier: true` (adres profilu pochodzi od podmiotu sprawy i jest ujawniany archiwum);
  cele: `wayback availability`, `wayback cdx listing`, `wayback snapshot`. robots.txt hosta archiwum jest respektowany przy pobieraniu snapshotów (zakaz daje `blocked` z notatką
  `robots_disallowed`; odpowiedź 429 na robots.txt jest traktowana jak nieosiągalny plik i dodatkowo wstrzymuje źródło do końca przebiegu (`rate_limited`), bez zapytania o snapshot; wynik jest buforowany w przebiegu jak dla innych hostów), a robots.txt
  witryny źródłowej nie jest sprawdzany dla kopii z archiwum. Zapytania Availability i CDX (API JSON) nie podlegają
  robots.txt. Treść snapshotu nie jest oceniana jako bariera (zarchiwizowana strona logowania jest treścią, nie blokadą).
- **Kopia archiwalna to ta sama grupa pochodzenia co strona, którą odwzorowuje.** Przechwycenie ma profil
  `archive_snapshot` i pole `archive` (`provider`, `snapshotTimestamp`, `originalUrl`, ponadto w manifeście
  `replayUrl` i `cdxDigest`); `collectedAt` to czas pobrania, nigdy czas snapshotu. Ocena punktowa przypisuje wzmianki w
  kopii temu samemu kontu co żywa strona, więc archiwum dodaje historię, nie punkty.
- **Pivot E6:** adres profilu konta podanego przez analityka albo wskazanego przez stronę własnego konta podmiotu (`input`,
  `cross_link`, w nieprzerwanym łańcuchu od konta podanego przez analityka — nigdy przez trafienie wyszukiwarki ani stronę osoby trzeciej) oraz strona z listy obserwowanych, na której dopasowano identyfikator, dostają jedno zadanie Wayback,
  o ile źródło `wayback_cdx` jest włączone w sprawie. Stron osób trzecich (próby tego samego nicku, wyniki
  wyszukiwania, kanały ostrzeżeń) i stron istniejących tylko na stronie testowej nigdy się nie sprawdza.

Obserwacje (podmiot: strona `{ type: 'page', key: <adres oryginalny> }`, lokalizator `wayback:<adres>@<znacznik>`):
`archive.snapshot` (znacznik) i `archive.digest` (skrót z CDX) dla każdego wpisu listy — fakty — oraz
`computed.archive_digest_check` (`match` / `mismatch`) dla każdej pobranego snapshotu — obliczenie. Każda odpowiedź API
(Availability, kolejne strony CDX) jest osobnym przechwyceniem w formacie JSON. `buildWaybackHistory(captures,
observations)` łączy je w wpisy osi czasu (`WaybackHistoryEntry`: adres, znacznik, czas ISO, skrót, `fetched`,
`captureId`, `digestCheck`), posortowane rosnąco — dane wejściowe dla osi czasu zmian profilu.

W trybach `offline` i `replay` archiwum symuluje strona testowa (`web.archive.org` → `/wayback`, `archive.org` →
`/archive-org`): snapshoty profilu persony na forum, z których starsza nie zawiera portfela, a nowsza pokazuje BTC-1.
Warunki korzystania z Internet Archive dopuszczają dostęp „dla celów naukowych i badawczych”; ich zgodność z użyciem
przez KAS pozostaje otwartym pytaniem prawnym (patrz `docs/compliance/sources.md`).

## Enumeracja nicków (Maigret przez osint-py)

Źródło `maigret` (AMBER, uruchamiane tylko wtedy, gdy sprawa je włączy z uzasadnieniem) pyta wewnętrzny serwis
`services/osint-py` (`POST {OSINT_PY_URL}/v1/usernames/search`, domyślnie `http://127.0.0.1:8090`) o jeden nick
(identyfikator `nickname` lub `social_login`). Serwis sam łączy się z serwisami z przypiętej bazy Maigreta — pod własną
listą dozwolonych hostów, limitem 4 zapytań/s i własnym dziennikiem — a kolektor:

- wysyła kanoniczne ciało żądania (`canonicalJson`, bez identyfikatora przebiegu i czasu: ten sam nick daje te same bajty,
  więc cassettes trybu `replay` pasują); identyfikator przebiegu idzie tylko w nagłówku `x-olcys-run-id`;
- w `database` wysyła `fixture` (offline i replay) albo `upstream` (live); `OSINT_PY_DATABASE=fixture|upstream` to zmienia;
- przekazuje `deniedHostSuffixes`: hosty źródeł rejestru, których sprawa nie włączyła (`CollectorDeps.deniedHosts`),
  oraz — po stronie serwisu — listę RED; serwis nie kontaktuje takich hostów;
- scala dziennik żądań serwisu z dziennikiem ruchu wychodzącego (`EgressClient.recordDelegated`): jeden wiersz na
  żądanie z polem `delegate: 'osint-py'`, `containsIdentifier: true`, odmowy jako `allowed: false`; dla żądań z treścią
  powstaje koperta pochodzenia z `delegatedVia`. Bez tej metody klienta kolektor **nic nie wysyła** (`error`, notatka
  `delegated_log_unavailable`);
- zapisuje przechwycenie raportu (JSON bez treści stron) oraz po jednym przechwyceniu na każdy znaleziony profil i każdą
  stronę bariery; konto-kandydat dostaje `discoveredVia.method = 'enumeration'` i **nie jest powiązaniem** — nie ma wagi
  w ocenie; planista może je zweryfikować kolektorami platform (reguły I2 i E1);
- obserwacje: `enumeration.status` (`found`, `not_found`, `blocked`, `login_wall`, `captcha`, `unknown`, `illegal`,
  `skipped`) dla każdego serwisu, a dla znalezionych profili `profile.<pole socid-extractor>` oraz odnośniki
  (`account.link` dla rozpoznanych kont, w przeciwnym razie `profile.link`).

Bariery (`blocked`, `login_wall`, `captcha`) i niepowodzenia (`unknown`) są zapisywane osobno od „brak profilu”
(`not_found`) i nigdy nie są ponawiane ani omijane. Status źródła: znaleziono i wszystkie serwisy odpowiedziały → `ok`
(z barierą lub brakiem odpowiedzi → `partial`); nic nie znaleziono i wszystkie odpowiedziały „brak” → `not_found`; same
bariery → najsilniejsza z nich; w pozostałych przypadkach `partial`. Odpowiedź `409` serwisu (`external_disabled`:
`OLCYS_OSINT_ALLOW_EXTERNAL` nie jest `true`; `db_hash_mismatch`: baza serwisów nie zgadza się z przypiętym skrótem)
daje `error` z odpowiednią notatką. W trybie `live` syntetyczny nick persony jest odrzucany (`synthetic_identifier_refused`).
Zasada 3 obowiązuje też tu, po stronie serwisu: osint-py pobiera `robots.txt` każdego hosta (raz na wyszukiwanie, przez
własny dziennik) i pomija adresy wyłączone (`skipped`, `robots_disallowed`); semantyka odpowiedzi jak w `RobotsCache`.
Poza trybem `live` kolektor wysyła wyłącznie `database: 'fixture'` i odrzuca `upstream` (`unsupported_input`), więc
`offline` i `replay` nigdy nie sięgają do zewnętrznego internetu przez osint-py.

## Wyszukiwania tożsamości (Keybase, BitList, ENS)

Trzy źródła odpowiadają na pytanie „jaki adres publicznie przypisano tej tożsamości” (albo odwrotnie) bez logowania i bez
kluczy. Moduły: `src/identity/`. Żadne z nich nie daje dowodu samo z siebie: obserwacje trafiają do zwykłej punktacji
(rozdz. „Słownik obserwacji”), a odpowiedź „nie znaleziono” jest tylko faktem o źródle.

### Keybase (`keybase`, GREEN)

- Zapytanie: `GET https://keybase.io/_/api/1.0/user/lookup.json?usernames=<login>&fields=basics,profile,proofs_summary,cryptocurrency_addresses`
  (tylko te pola; jeden login na zapytanie; 1 zapytanie/s z rejestru). Login: `^[a-z0-9_]{2,16}$`; nick z łącznikiem, zbyt
  krótki albo e-mail nie jest wysyłany (`unsupported_input`).
- `them: [null]` lub `NOT_FOUND` → `not_found` (odpowiedź twierdząca). Inny kod statusu, odpowiedź niebędąca JSON-em
  (np. strona serwisowa) albo 5xx → `error` — usługa jest tylko utrzymywana, więc jej zniknięcie nigdy nie jest
  „nie znaleziono”. 429/403 → `blocked` i wstrzymanie źródła do końca przebiegu.
- Podpisany adres (`cryptocurrency_addresses`) → `verification.<moneta>_address` i `verification.<moneta>_sig_id`.
  `sig_id` dowodzi, że klucz łańcucha podpisów konta złożył oświadczenie, a **nie** że klucz adresu — dlatego punktacja
  nadal przechodzi przez zwykłe reguły (dowód kryptograficzny „E1” wagi v1 dotyczy tej obserwacji, ale nie omija bramek).
  Zcash nie ma jeszcze rodziny łańcucha w rdzeniu: adres jest zapisany jako fakt z notatką `unsupported_input`.
- Dowody kont (`proofs_summary`): zawsze `account.proof`, `verification.proof_state`, `verification.proof_sig_id`; tylko stan
  `1` (OK) tworzy `account.link` i konto z `method: 'cross_link'` (GitHub, X, Reddit, Hacker News, strona/DNS). Adres
  dowodzonego konta budowany jest z typu dowodu i nazwy, nigdy brany z odpowiedzi. Konta z serwisów czerwonych (X, Reddit)
  są tylko zapisywane.

### BitList (`bitlist`, AMBER)

- Archiwum Bitcointalk osoby trzeciej, bez opublikowanych warunków i limitów; każde zapytanie ujawnia identyfikator
  prywatnemu operatorowi. Działa tylko w sprawie, która włącza źródło z uzasadnieniem (≥ 20 znaków). W produkcji lepsze są
  publiczne zrzuty danych.
- Zapytania (interfejs nieudokumentowany; używane tylko zaobserwowane parametry `author`, `address`, `limit`; nigdy `board=`
  ani tekst swobodny): `/addresses?author=<nick>&limit=50`, `/posts?author=<nick>&limit=50`,
  `/addresses?address=<adres>&limit=50` (adresy `bitcoin` i `evm`). Jedno zapytanie na identyfikator i kierunek, 1 na 2 s.
  Weryfikacja parametrów na żywym interfejsie: **niewykonana** (tylko odpowiedzi syntetyczne).
- `result !== 'success'` → `error` (nigdy `not_found`); `total_results: 0` → `not_found`; 429/403 → `blocked`; więcej wyników
  niż zwrócono → notatka `truncated: <zwrócone> of <razem>`.
- Minimalizacja danych: do obserwacji trafiają tylko trafienia, w których autor to wyszukiwany nick albo adres to wyszukiwany
  adres; surowa odpowiedź zostaje w przechwyceniu.
- Konto `bitcointalk` z numerem uid (`method: 'search'`), obserwacje `archive.post.*` (kopia treści autora u osoby trzeciej,
  **kontekst E3**, w tej samej grupie źródeł co wpis forum, który odbija; wartość adresu jest walidowana dopiero przy
  ekstrakcji) i fakty `post.signed_message.*` z archiwalnych wpisów (weryfikacja podpisu odbywa się przy ocenie dowodów).
  Uid prowadzi (reguła E7) do kolektora forum. Autorzy znalezieni po adresie to osoby trzecie: są zapisywani, ale nie są pivotami.

### ENS (`ens`, GREEN)

- Węzeł: JSON-RPC Ethereum wybrany przez wdrożenie. Zmienne: `ENS_RPC_URL` (bez domyślnej wartości: komercyjny węzeł widziałby
  każdy badany adres; zalecany własny węzeł), `ENS_UNIVERSAL_RESOLVER` (adres Universal Resolver wdrożenia; nie jest
  wpisany w kodzie) i host węzła w `OLCYS_SOURCE_HOSTS_ENS` (rejestr ma `allowedHosts: []`; nadpisanie dotyczy tylko źródeł
  bez hostów w rejestrze). Bez `ENS_RPC_URL` w trybie `live` kolektor nie jest rejestrowany; host spoza listy albo zły adres
  resolvera to błąd konfiguracji przy starcie. Offline i w replay odpowiada syntetyczny węzeł strony testowej (POST pod
  `ens-rpc.example` → `/ens-rpc/`). Każde wywołanie to `EgressClient` (`containsIdentifier: true`, przypięty blok), bez
  indeksatorów, bramek CCIP-Read (odpowiedź `OffchainLookup` → notatka `unsupported_input: ccip-read disabled`) i bez pobierania awatarów.
- Nazwa główna adresu liczy się **tylko po weryfikacji w przód** (nazwa → adres wraca do tego samego adresu); wtedy powstaje
  konto `ens` (`protocol_lookup`) i obserwacja `ens.verified_address` (kandydat E1). Rozbieżność → `computed.ens.forward_verified`
  `false`, bez konta. Rekordy tekstowe, adres nazwy (`profile.ens_address`) i adresy innych sieci (`profile.ens_btc_address`,
  `profile.ens_trx_address`) to oświadczenia zarządcy nazwy (każdy może wskazać nazwę na dowolny adres): **E2**, nie E1.
  Rekordy tekstowe są niezaufanymi danymi: znaki sterujące usunięte, do 2 KB, nigdy nie są pobierane; `account.link` powstaje
  tylko z poprawnie zbudowanego loginu (`com.github`, `com.twitter`, `org.telegram`, `io.keybase`) albo adresu `http(s)` z `url`.
- Normalizacja nazw to ścisły podzbiór ENSIP-15 (małe litery ASCII, cyfry, `-`, `_` wiodące); nazwy z innymi znakami
  (w tym niewidocznymi, np. U+200B, i mylącymi z innych alfabetów) są odrzucane (`unsupported_input`, 0 zapytań), a nie zgadywane.
  Odczytywane monety ENSIP-9: BTC (0) i TRX (195); pozostałe są pominięte. Zamiast biblioteki viem (bez nowej zależności o
  dużym rozmiarze) kodowanie ABI i namehash są własne, na `@noble/hashes` i `@scure/base`; zgodność z żywym Universal Resolver
  nie była sprawdzana (tylko węzeł syntetyczny).

### Dane testowe

Persona demonstracyjna jest nieznana wszystkim trzem źródłom (odpowiedzi „nie znaleziono”), więc jej wynik nie zmienia się.
Druga syntetyczna tożsamość `olcys_test_ewa` / `olcys-test-ewa.eth` (uid 900201) jest „znaleziona” i służy testom
kolektorów (`test/identity.test.ts`); jej adresy są losowymi bajtami w poprawnym formacie, wyprowadzonymi z seedu manifestu.

## Farcaster i Nostr (NIP-05)

**Farcaster** (źródło AMBER, tylko gdy sprawa je włącza z uzasadnieniem): węzeł Snapchain (`FARCASTER_HUB_URL`, domyślnie
`haatz.quilibrium.com`; zalecany własny węzeł, bo widzi każde zapytanie; jego host trzeba dopisać do `allowedHosts` źródła `farcaster` w `config/sources.yaml` – to przeglądana zmiana rejestru, sama zmienna środowiskowa nie wystarcza) zwraca zweryfikowane adresy fname lub FID.
Wejście: identyfikator z `platform: 'farcaster'` (fname albo numeryczny FID). Odpowiedzi (`userNameProofByName`,
`userDataByFid`, `verificationsByFid` ze stronicowaniem do `maxVerificationPages`, domyślnie 5) są zapisywane po
zredagowaniu sekretów (`persistBody: false`), pola bajtowe mogą być hex albo base64. Podpis `claimSignature` (EIP-712)
sprawdzamy lokalnie: `computed.claim_signature_check` = `valid` | `invalid` | `unverifiable_contract` | `unverifiable_solana`
(własne obliczenie, osobno od faktów `verification.eth_address`, `verification.sol_address`, `verification.added_at`,
`verification.message_hash`; lokalizator zawiera adres, więc usunięcie weryfikacji to usunięcie jednego lokalizatora).
Profil: `profile.*`, `account.custody_address`; konto GitHub z profilu jest `account.link`. Weryfikacja Ed25519
wiadomości i odwrotne wyszukiwanie adres → FID są poza zakresem (planowane).

**Nostr** (GREEN): wyszukanie NIP-05 (`/.well-known/nostr.json?name=` na domenie identyfikatora, bez podążania za
przekierowaniami: 3xx = `not_found` z notatką „NIP-05 redirect ignored”). Wejście: identyfikator `nazwa@domena` z
`platform: 'nostr'`; zwykły e-mail nigdy nie staje się zapytaniem NIP-05. Domena jest dynamiczna: wdrożenie dopisuje ją do
`OLCYS_SOURCE_HOSTS_NOSTR`. Wynik: konto `nostr:<hex>`, `nostr.pubkey`, `nostr.npub`, `nostr.nip05`, `nostr.relay_hint`
(podpowiedzi przekaźników są tylko faktami i nigdy nie są kontaktowane). NIP-05 tylko wskazuje klucz, nie dowodzi tożsamości.
Profil (kind 0: adres Lightning, adresy kryptowalut) wymaga WebSocket przez klienta wyjścia i jest planowany.

Dane syntetyczne: fname `olcys-test-marek` (FID 999999998) i `olcys_test_nostr@nostr.example.org` na stronie
fixture; persona demo jest tam nieznana, a nick nigdy nie trafia do tych źródeł.

## Pivoty (`pivot.v4`)

| Reguła                 | Wyzwalacz                                                                                                                         | Zadanie                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1                     | identyfikator podany dla platformy P                                                                                              | kolektor platformy P                                                                                                                                                                    |
| I2                     | nick / login                                                                                                                      | ten sam nick na pozostałych platformach (GitHub: `_` i `.` → `-`)                                                                                                                       |
| I3                     | dowolny identyfikator                                                                                                             | strony z listy obserwowanych; zachowane tylko, gdy zawierają identyfikator                                                                                                              |
| I4                     | identyfikator będący adresem profilu                                                                                              | kolektor rozpoznanej platformy                                                                                                                                                          |
| E1                     | `account.link` do rozpoznanego konta                                                                                              | kolektor tej platformy (głębokość + 1)                                                                                                                                                  |
| E2                     | konto znalezione dla osoby inaczej niż próbą nicku (nie kanał ostrzeżeń)                                                          | jego login na pozostałych platformach (głębokość + 1)                                                                                                                                   |
| I5                     | imię i nazwisko, nick, e-mail, adres kryptowaluty                                                                                 | każda zarejestrowana wyszukiwarka: jedno zapytanie (dokładna fraza)                                                                                                                     |
| E3                     | `search.result_url` (wynik wyszukiwania)                                                                                          | kolektor strony (klucz jak I3) albo konta (jak E1) (głębokość + 1)                                                                                                                      |
| I6                     | identyfikator rodzaju, który źródło wyszukuje samo: imię i nazwisko (`full_name`), nick / login (`nickname`, `social_login`)      | CEIDG: jedno wyszukiwanie po imieniu i nazwisku; Maigret: jedna enumeracja nicku (klucz `name:<tekst>`)                                                                                 |
| E4                     | `registry.nip` z CEIDG                                                                                                            | wykaz VAT (głębokość + 1) — **tylko** gdy `registry.ceidg.result_count` = 1; w przeciwnym razie pominięcie `ambiguous_namesake`                                                         |
| E5                     | `registry.krs` z wykazu VAT                                                                                                       | KRS (głębokość + 1)                                                                                                                                                                     |
| I7 (nowa w `pivot.v3`) | `crypto_address` (rodzina `evm`; `bitcoin` także dla BitList)                                                                     | źródła szukające adresów same: ENS (nazwa główna), BitList (adres → autorzy); jedno zadanie na adres (`address:<sieć>:<adres>`)                                                         |
| I8 (nowa w `pivot.v3`) | identyfikator kończący się na `.eth`                                                                                              | ENS: sprawdzenie nazwy w przód i rekordy tekstowe (klucz `name:<nazwa>`)                                                                                                                |
| E7 (nowa w `pivot.v3`) | konto innej platformy znalezione przez źródło-odsyłacz (uid z BitList)                                                            | kolektor tej platformy (głębokość + 1); nigdy dla kont znalezionych po adresie                                                                                                          |
| I9 (nowa w `pivot.v4`) | identyfikator podany dla Farcastera albo Nostra (fname / FID, `nazwa@domena`)                                                     | tylko to źródło (I1): żadne z nich nie dostaje nicku (Farcaster jest AMBER, a węzeł i domena NIP-05 widzą zapytanie); konto GitHub z profilu Farcastera idzie przez `account.link` (E1) |
| E6 (od `pivot.v2`)     | profil własnego konta (`input`, `cross_link` w nieprzerwanym łańcuchu własnych kont) albo dopasowana strona z listy obserwowanych | historia z archiwum (Wayback), ta sama głębokość: to sprawdzenie, nie pivot; nigdy strony osób trzecich                                                                                 |

Nick trafia do Keybase i BitList regułą I2, jak do każdej platformy z loginami. Konta, do których źródło-odsyłacz (`accountsAreReferences`)
tylko odsyła (uid z BitList, dowód Keybase), nie oznaczają kolektora tej platformy jako „już zebrany”: forum albo GitHub
zbierają je same. Wersja reguł: `pivot.v4` (v3 dodała I7, I8 i E7; v4 dodała I9).

Osoby trzecie z rejestrów (reprezentanci, prokurenci, wspólnicy, zarząd) nigdy nie są pivotami. Wyszukiwania (I5) są planowane po wszystkich pozostałych regułach identyfikatorów, więc nie zabierają limitu zadań
kolektorom platform. Wyniki wyszukiwania (E3) trafiają do kolektora strony z listy obserwowanych, który ją czyta — pod
tym samym kluczem co zadanie I3, więc strona znaleziona obiema drogami jest zbierana raz — a w przeciwnym razie do
kolektora rozpoznanego konta (jak E1); strony bez kolektora (np. wątki forum) nie są pobierane. Strona z listy
obserwowanych albo z wyników, która jest stroną konta tej platformy (np. podgląd kanału), ma też klucze tego konta:
próba nicku, odnośnik i wynik wyszukiwania prowadzą wtedy do jednego zadania. Kolektor strony wybiera sam jej adres —
identyfikatory sprawy idą z zadaniem tylko do dopasowania na stronie. Zadanie wskazujące strony (adresy URL) dotyczy
wyłącznie tych stron: kolektor nie sięga wtedy po identyfikatory ani konta swojej platformy.

Każde zadanie ma klucz `<sourceId>|<podmiot>` (np. `bitcointalk|handle:bitcointalk:fikcyjny_kacper`,
`bitcointalk|id:bitcointalk:900001`, `mock_search|query:kacper fikcyjny` — zapytanie małymi literami, odstępy scalone;
dla adresu kryptowaluty `…|address:<sieć>:<adres>`) i zapisany powód. Wielkość liter i początkowe `@` nie mają
znaczenia, interpunkcja tak (`a-b` i `a_b` to różne konta). Pominięcia: `source_red`, `amber_without_justification`,
`unknown_source`, `source_not_enabled`, `not_registered`, `unsupported`, `depth_exceeded` (`maxPivotDepth` sprawy),
`duplicate` (także konto już znalezione pod innym kluczem), `already_collected` (zadanie w kolejce objęte kontem
zebranym wcześniej w przebiegu), `budget_exceeded` (domyślnie 40 zadań), `ambiguous_namesake` (CEIDG znalazł więcej niż jedną firmę o tym imieniu i nazwisku — nie ma automatycznego pivotu, bo to ryzyko pomyłki z inną osobą). Lista obserwowanych
stron: offline i replay — strony z manifestu persony (jak mapa witryny), live — `OLCYS_WATCH_PAGES` (`platforma=adres`, po przecinku).

## Słownik obserwacji

Klucz konta: `<platforma>:<uid albo login małymi literami>`; klucz strony (posta) odpowiada kotwicy DOM posta, więc
ekstraktor może przypisać wzmiankę autorowi. Lokalizator: `<klucz>#<właściwość>` (`[i]` dla powtórzeń).

| Właściwość                                                                                | Podmiot                             | Znaczenie                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `profile.<pole>` (`bitcoin_address`, `name`, `website`, `date_registered`, …)             | konto `bitcointalk:<uid>`           | pole profilu forum (lokalizator `bitcointalk:u=<uid>#profile.<pole>`)                                                                     |
| `post.signed_message.address`, `.text`, `.signature`, `.armor`                            | konto autora `bitcointalk:<uid>`    | blok podpisanej wiadomości (bez weryfikacji), `bitcointalk:msg=<m>#signed_message[<i>]`                                                   |
| `post.signed_message.in_quote`, `.quote_author`                                           | strona `bitcointalk:msg=<m>`        | kopia bloku w cytacie innego użytkownika                                                                                                  |
| `post.author`, `post.author_name`                                                         | strona (post)                       | autor posta (klucz konta) i jego nazwa                                                                                                    |
| `post.published_at`, `post.subject`, `post.board`, `post.url`, `post.text`                | strona (post)                       | data (UTC), temat, dział, adres logiczny, treść                                                                                           |
| `account.link`                                                                            | konto                               | adres logiczny innego rozpoznanego konta (w tej samej postaci co `profileUrl`)                                                            |
| `enumeration.status`, `profile.<pole>`, `profile.link`                                    | konto-kandydat `<platforma>:<nick>` | wynik enumeracji Maigret dla serwisu; pola profilu z socid-extractor; odnośnik nierozpoznany                                              |
| `profile.about`                                                                           | konto `wykop:<login>`               | opis profilu                                                                                                                              |
| `profile.name`, `profile.bio`, `profile.repository`                                       | konto `github:<login>`              | profil serwisu z kodem                                                                                                                    |
| `claim.drips.<sieć>_address`, `claim.funding_json`                                        | konto `github:<login>`              | `ownedBy` z `FUNDING.json` i surowa treść pliku                                                                                           |
| `profile.name`, `profile.login`, `profile.email`, `profile.member_since`                  | konto `tablica:<login>`             | dane sprzedającego z ogłoszenia P2P                                                                                                       |
| `post.title`, `post.price`                                                                | strona `tablica:ad=<id>`            | tytuł i cena ogłoszenia                                                                                                                   |
| `profile.name`, `profile.description`                                                     | konto `telegram:<kanał>`            | nazwa i opis kanału                                                                                                                       |
| `archive.snapshot`, `archive.digest`, `computed.archive_digest_check`                     | strona (adres oryginalny)           | wpis listy CDX Wayback (znacznik, skrót) i obliczone porównanie skrótu pobranego snapshotu                                                |
| `computed.identifier_match`                                                               | konto sprzedającego / post kanału   | obliczenie OŁCyŚ: który identyfikator sprawy pasuje (`email`, `full_name`, `nickname`, …)                                                 |
| `search.result_url`                                                                       | strona `search:<dostawca>:<sha>`    | adres wyniku; lokalizator `search:<dostawca>:<sha256 zapytania>#rank=<n>`                                                                 |
| `search.result_count`                                                                     | strona `search:<dostawca>:<sha>`    | liczba wyników (tylko pełna lista)                                                                                                        |
| `verification.<moneta>_address`, `verification.<moneta>_sig_id`                           | konto `keybase:<login>`             | adres podpisany kluczem konta Keybase (E1 wagi v1) i identyfikator podpisu; lokalizator `…#cryptocurrency_addresses.<moneta>[<i>]`        |
| `account.proof`, `verification.proof_state`, `verification.proof_sig_id`                  | konto `keybase:<login>`             | dowód konta w innym serwisie (`<typ>:<nazwa>`), stan (1 = OK) i podpis; lokalizator `…#proof[<sig_id>]`                                   |
| `profile.full_name`, `.location`, `.bio`, `.created_at`, `.updated_at`                    | konto `keybase:<login>`             | pola profilu Keybase (deklaracje właściciela) i daty konta                                                                                |
| `archive.post.address`, `.coin`, `.board`, `.published_at`, `.title`, `.url`, `.text`     | konto `bitcointalk:<uid>`           | kopia wpisu z archiwum BitList (kontekst E3); lokalizator `bitlist:post=<id>#address[<i>]`                                                |
| `ens.primary_name`, `computed.ens.forward_verified`                                       | adres `evm:1:<adres>`               | nazwa główna adresu i wynik weryfikacji w przód (obliczenie OŁCyŚ); lokalizator `ens:addr=<adres>#reverse.60`                             |
| `ens.verified_address`                                                                    | konto `ens:<nazwa>`                 | adres, do którego nazwa wraca — **tylko** po weryfikacji w przód (kandydat E1)                                                            |
| `profile.ens_address`, `profile.ens_<moneta>_address`, `ens.text.<klucz>`, `account.link` | konto `ens:<nazwa>`                 | oświadczenia zarządcy nazwy (E2), niezaufane teksty oczyszczone i obcięte do 2 KB; lokalizator `ens:<nazwa>#addr.<typ>` / `#text.<klucz>` |
| `registry.*` (opis w sekcji „Rejestry publiczne”)                                         | strona `ceidg:` / `vat:` / `krs:`   | fakty z urzędowych rejestrów; osoby trzecie tylko jako nazwa i rola, nigdy PESEL                                                          |

Pola zmieniające się przy każdej wizycie (`Last Active`, `Local Time`, `Current Status`) zostają tylko w przechwyceniu.

## Kody notatek

Notatki mają postać `kod: szczegóły`; interfejs tłumaczy kod.

| Kod                            | Tekst polski                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `robots_disallowed`            | Strona wyłączona w robots.txt — nie pobrano                       |
| `allow_list_denied`            | Host spoza listy dozwolonych — nie pobrano                        |
| `barrier_captcha`              | CAPTCHA lub wyzwanie przeglądarki — pominięto bez obchodzenia     |
| `barrier_login_wall`           | Wymagane logowanie — pominięto                                    |
| `barrier_blocked`              | Dostęp zablokowany — pominięto                                    |
| `rate_limited`                 | Przekroczony limit zapytań — źródło wstrzymane do końca przebiegu |
| `source_stopped`               | Źródło wstrzymane po wcześniejszej barierze                       |
| `replay_miss`                  | Brak nagrania odpowiedzi (tryb odtwarzania)                       |
| `fetch_error`                  | Błąd połączenia lub przekroczony czas                             |
| `no_fixture_for_host`          | Brak odwzorowania hosta na stronie testowej                       |
| `unsupported_input`            | Dane wejściowe nieobsługiwane przez kolektor                      |
| `synthetic_identifier_refused` | Odrzucono: syntetyczny identyfikator w trybie na żywo             |
| `not_found`                    | Źródło odpowiedziało, że profil lub ślad nie istnieje             |
| `no_identifier_match`          | Strona nie zawiera identyfikatorów sprawy — nie zachowano         |
| `unrecognised_markup`          | Nierozpoznana struktura strony                                    |
| `malformed_link`               | Pominięto odnośnik z błędnym kodowaniem adresu                    |
| `redirect_limit`               | Za dużo przekierowań                                              |
| `truncated`                    | Odczytano tylko część elementów (limit)                           |
| `search_provider_error`        | Błąd wyszukiwarki (klucz, plan, zapytanie lub odpowiedź)          |
| `search_query_altered`         | Wyszukiwarka zmieniła zapytanie — wyniki odrzucone                |
| `search_index_skipped`         | Strona pominięta w indeksie wyszukiwarki testowej                 |
| `search_results_not_stored`    | Warunki dostawcy: zapisano tylko pozycję i adres wyników          |
| `external_disabled`            | osint-py nie ma zgody na serwisy zewnętrzne (`ALLOW_EXTERNAL`)    |
| `db_hash_mismatch`             | Baza serwisów osint-py różni się od przypiętej (skrót SHA-256)    |
| `delegated_log_unavailable`    | Klient nie potrafi scalić dziennika osint-py — nic nie wysłano    |

## Konfiguracja

`OLCYS_FIXTURE_BASE_URL` (lub `FIXTURE_SITE_URL`) — adres strony testowej; `OLCYS_WATCH_PAGES` — lista
obserwowanych stron w trybie `live`. Wyszukiwarki: `OLCYS_SEARCH_MODE` (`off` | `mock` | `external`, domyślnie `mock`),
`BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_STORAGE_RIGHTS` (`true` tylko z planem, który pozwala przechowywać wyniki),
`MOJEEK_API_KEY`, `MOJEEK_PLAN` (`startup` | `business` | `enterprise`, domyślnie `startup`); rejestry: `CEIDG_API_TOKEN`
(tylko `live`; bez niego CEIDG nie jest rejestrowany); ENS: `ENS_RPC_URL`, `ENS_UNIVERSAL_RESOLVER`, `OLCYS_SOURCE_HOSTS_ENS` (host węzła; tylko źródła bez hostów w rejestrze; przykład: `OLCYS_SOURCE_HOSTS_ENS=node.example.org`); Maigret: `OSINT_PY_URL` (domyślnie `http://127.0.0.1:8090`) i
`OSINT_PY_DATABASE` (`fixture` | `upstream`; domyślnie `fixture` poza trybem `live`). Klucze wyłącznie ze zmiennych środowiskowych.
