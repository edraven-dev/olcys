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

## Publiczne API (wywołanie z potoku)

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

- `scope.egressSources` — deskryptory dla klienta egress; offline każde źródło dostaje limit strony testowej.
- `createDefaultCollectorRegistry({ mode, env })` — kolektory poniżej oraz wyszukiwarki według `OLCYS_SEARCH_MODE`
  (`collectCase` bez `collectors` buduje go z trybu przebiegu i opcji `env`; bez `env` — wyszukiwarka testowa);
  `runCollector()` uruchamia jeden kolektor w zakresie; `isSearchResultCapture()` rozpoznaje przechwycenia list wyników.
- Elementy do ponownego użycia: `fetchPage`, `detectAccessBarrier`, `toFixtureUrl` / `toLogicalUrl` /
  `recogniseAccountUrl`, `ResultBuilder`, `buildCapture`, `rollupStatus`, parsery stron.

Przechwycenie (`Capture`): adres pobrany i końcowy, czas, kolektor, wersja narzędzia, user agent, status HTTP i status
zbierania, artefakty `html`/`json`/`text` (bajty jak odebrane albo — gdy usunięto sekrety — tekst po redakcji w UTF-8; skrót
oryginału zostaje w kopercie pochodzenia i w `technical.redaction`) oraz `headers` (kanoniczny JSON), identyfikatory pobrań całego łańcucha przekierowań,
`manifestSha256` oraz `technical` (adres logiczny, przekierowania, decyzja robots.txt, sygnały bariery, redakcja, wersje parserów).

## Kolektory

| Źródło (`sourceId`) | Platforma     | Tryby         | Co zbiera                                                                                |
| ------------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `bitcointalk`       | `bitcointalk` | offline, live | profil → „Show Posts” → do 3 wątków (najpierw z podpisaną wiadomością, potem z adresem)  |
| `wykop`             | `wykop`       | offline       | profil społecznościowy: opis, linki do innych kont (`account.link`), wpisy               |
| `github`            | `github`      | offline       | profil z tym samym nickiem → repozytoria → surowy `FUNDING.json` (roszczenia Drips)      |
| `telegram_preview`  | `telegram`    | offline, live | publiczny podgląd kanału `t.me/s/<kanał>`: opis kanału, posty z autorem (strona trzecia) |
| `fixture_site`      | `tablica`     | offline       | ogłoszenie P2P: sprzedający (imię i nazwisko, login, e-mail), treść ogłoszenia           |
| `mock_search`       | `web_search`  | offline       | wyszukiwarka testowa: strony z mapy witryny strony testowej zawierające zapytanie        |
| `brave_search`      | `web_search`  | live, replay  | Brave Search API: wyniki wyszukiwania dokładnej frazy (tylko w trybie `external`)        |
| `mojeek_search`     | `web_search`  | live, replay  | Mojeek Search API: wyniki wyszukiwania dokładnej frazy (tylko w trybie `external`)       |

Profil forum po nazwie (`action=profile;user=`) jest sprawdzony tylko na stronie testowej; w trybie `live` potrzebny
jest numer uid albo adres profilu. Strony Wykopu, GitHuba (HTML) i ogłoszeń istnieją tylko na stronie testowej.
Wyszukiwarka testowa działa w trybach `offline` i `replay` (w `live` zadanie jest pomijane jako `unsupported`).

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

## Pivoty (`pivot.v1`)

| Reguła | Wyzwalacz                                                                | Zadanie                                                                    |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| I1     | identyfikator podany dla platformy P                                     | kolektor platformy P                                                       |
| I2     | nick / login                                                             | ten sam nick na pozostałych platformach (GitHub: `_` i `.` → `-`)          |
| I3     | dowolny identyfikator                                                    | strony z listy obserwowanych; zachowane tylko, gdy zawierają identyfikator |
| I4     | identyfikator będący adresem profilu                                     | kolektor rozpoznanej platformy                                             |
| E1     | `account.link` do rozpoznanego konta                                     | kolektor tej platformy (głębokość + 1)                                     |
| E2     | konto znalezione dla osoby inaczej niż próbą nicku (nie kanał ostrzeżeń) | jego login na pozostałych platformach (głębokość + 1)                      |
| I5     | imię i nazwisko, nick, e-mail, adres kryptowaluty                        | każda zarejestrowana wyszukiwarka: jedno zapytanie (dokładna fraza)        |
| E3     | `search.result_url` (wynik wyszukiwania)                                 | kolektor strony (klucz jak I3) albo konta (jak E1) (głębokość + 1)         |

Wyszukiwania (I5) są planowane po wszystkich pozostałych regułach identyfikatorów, więc nie zabierają limitu zadań
kolektorom platform. Wyniki wyszukiwania (E3) trafiają do kolektora strony z listy obserwowanych, który ją czyta — pod
tym samym kluczem co zadanie I3, więc strona znaleziona obiema drogami jest zbierana raz — a w przeciwnym razie do
kolektora rozpoznanego konta (jak E1); strony bez kolektora (np. wątki forum) nie są pobierane. Strona z listy
obserwowanych albo z wyników, która jest stroną konta tej platformy (np. podgląd kanału), ma też klucze tego konta:
próba nicku, odnośnik i wynik wyszukiwania prowadzą wtedy do jednego zadania.

Każde zadanie ma klucz `<sourceId>|<podmiot>` (np. `bitcointalk|handle:bitcointalk:fikcyjny_kacper`,
`bitcointalk|id:bitcointalk:900001`, `mock_search|query:kacper fikcyjny` — zapytanie małymi literami, odstępy scalone;
dla adresu kryptowaluty `…|address:<sieć>:<adres>`) i zapisany powód. Wielkość liter i początkowe `@` nie mają
znaczenia, interpunkcja tak (`a-b` i `a_b` to różne konta). Pominięcia: `source_red`, `amber_without_justification`,
`unknown_source`, `source_not_enabled`, `not_registered`, `unsupported`, `depth_exceeded` (`maxPivotDepth` sprawy),
`duplicate` (także konto już znalezione pod innym kluczem), `already_collected` (zadanie w kolejce objęte kontem
zebranym wcześniej w przebiegu), `budget_exceeded` (domyślnie 40 zadań). Lista obserwowanych
stron: offline i replay — strony z manifestu persony (jak mapa witryny), live — `OLCYS_WATCH_PAGES` (`platforma=adres`, po przecinku).

## Słownik obserwacji

Klucz konta: `<platforma>:<uid albo login małymi literami>`; klucz strony (posta) odpowiada kotwicy DOM posta, więc
ekstraktor może przypisać wzmiankę autorowi. Lokalizator: `<klucz>#<właściwość>` (`[i]` dla powtórzeń).

| Właściwość                                                                    | Podmiot                           | Znaczenie                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `profile.<pole>` (`bitcoin_address`, `name`, `website`, `date_registered`, …) | konto `bitcointalk:<uid>`         | pole profilu forum (lokalizator `bitcointalk:u=<uid>#profile.<pole>`)                     |
| `post.signed_message.address`, `.text`, `.signature`, `.armor`                | konto autora `bitcointalk:<uid>`  | blok podpisanej wiadomości (bez weryfikacji), `bitcointalk:msg=<m>#signed_message[<i>]`   |
| `post.signed_message.in_quote`, `.quote_author`                               | strona `bitcointalk:msg=<m>`      | kopia bloku w cytacie innego użytkownika                                                  |
| `post.author`, `post.author_name`                                             | strona (post)                     | autor posta (klucz konta) i jego nazwa                                                    |
| `post.published_at`, `post.subject`, `post.board`, `post.url`, `post.text`    | strona (post)                     | data (UTC), temat, dział, adres logiczny, treść                                           |
| `account.link`                                                                | konto                             | adres logiczny innego rozpoznanego konta (w tej samej postaci co `profileUrl`)            |
| `profile.about`                                                               | konto `wykop:<login>`             | opis profilu                                                                              |
| `profile.name`, `profile.bio`, `profile.repository`                           | konto `github:<login>`            | profil serwisu z kodem                                                                    |
| `claim.drips.<sieć>_address`, `claim.funding_json`                            | konto `github:<login>`            | `ownedBy` z `FUNDING.json` i surowa treść pliku                                           |
| `profile.name`, `profile.login`, `profile.email`, `profile.member_since`      | konto `tablica:<login>`           | dane sprzedającego z ogłoszenia P2P                                                       |
| `post.title`, `post.price`                                                    | strona `tablica:ad=<id>`          | tytuł i cena ogłoszenia                                                                   |
| `profile.name`, `profile.description`                                         | konto `telegram:<kanał>`          | nazwa i opis kanału                                                                       |
| `computed.identifier_match`                                                   | konto sprzedającego / post kanału | obliczenie OŁCyŚ: który identyfikator sprawy pasuje (`email`, `full_name`, `nickname`, …) |
| `search.result_url`                                                           | strona `search:<dostawca>:<sha>`  | adres wyniku; lokalizator `search:<dostawca>:<sha256 zapytania>#rank=<n>`                 |
| `search.result_count`                                                         | strona `search:<dostawca>:<sha>`  | liczba wyników (tylko pełna lista)                                                        |

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

## Konfiguracja

`OLCYS_FIXTURE_BASE_URL` (lub `FIXTURE_SITE_URL`) — adres strony testowej; `OLCYS_COLLECTOR_NAME` — osoba lub konto
usługi zapisywane w przechwyceniach; `OLCYS_CLOCK_SYNCED=1` — zegar zweryfikowany z NTP; `OLCYS_WATCH_PAGES` — lista
obserwowanych stron w trybie `live`. Wyszukiwarki: `OLCYS_SEARCH_MODE` (`off` | `mock` | `external`, domyślnie `mock`),
`BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_STORAGE_RIGHTS` (`true` tylko z planem, który pozwala przechowywać wyniki),
`MOJEEK_API_KEY`, `MOJEEK_PLAN` (`startup` | `business` | `enterprise`, domyślnie `startup`). Klucze wyłącznie ze
zmiennych środowiskowych.
