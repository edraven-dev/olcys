# olcys-osint (serwis w Pythonie)

Wewnętrzna usługa HTTP wywoływana wyłącznie przez `apps/worker`. Istnieje, ponieważ Maigret i socid-extractor (MIT)
są dostępne tylko w Pythonie i nie mają odpowiedników w innych językach, a pyHanko (MIT) służy do podpisywania raportów
PDF. To jedyne uzasadnienie użycia Pythona w repozytorium (zob. `docs/adr/0001-technology-stack.md`).

```bash
docker compose --profile osint up -d --build --wait
curl http://127.0.0.1:8090/healthz
```

- Python 3.15, zależności zarządzane przez [uv](https://github.com/astral-sh/uv) 0.13.9. Plik blokady `uv.lock` jest w
  repozytorium (bramka licencji widzi pełny zestaw zależności). Lokalna instalacja uv nie jest potrzebna; plik tworzy się
  w kontenerze z Pythonem 3.15 (obraz `ghcr.io/astral-sh/uv` nie zawiera Pythona):
  `docker run --rm -v "$PWD":/app -w /app python:3.15.2-slim-trixie sh -c "pip install uv==0.13.9 && uv lock"`.
  Obraz serwisu instaluje zależności poleceniem `uv sync --frozen --no-dev`.
- Wszystkie zależności mają dokładne wersje (`==`) w `pyproject.toml`; każda jest wpisana do
  `config/compliance/components.yaml` i do `docs/compliance/licenses.md`. Zależność `opentelemetry-api` pochodzi od
  FastAPI: to wyłącznie interfejs (bez SDK i eksportera), więc nic nie opuszcza usługi.
- Telemetria wyłączona (`DO_NOT_TRACK`, `HF_HUB_OFFLINE` w `Dockerfile` i `compose.yml`).
- Podpisywanie PDF (pyHanko 0.38.2, PAdES) działa dwufazowo (`/v1/pdf/sign/prepare`, `/v1/pdf/sign/finish`);
  zapytanie do serwera znaczników czasu wykonuje worker w Node przez klienta ruchu wychodzącego, więc ten serwis nie
  łączy się z nim sam (testy podpisu uruchamiają się z zablokowanym `socket.socket.connect`).

## Interfejs

| Metoda i ścieżka            | Znaczenie                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /healthz`              | stan usługi (`allow_external`, wersja)                                                            |
| `POST /v1/usernames/search` | wyszukanie nicku w serwisach z przypiętej bazy Maigreta (opis niżej)                              |
| `POST /v1/profiles/extract` | `{ html, url }` → `{ ids, idsLinks }`: socid-extractor na zapisanej stronie, bez sieci            |
| `POST /v1/pdf/sign/prepare` | podpis przerwany: przygotowuje PDF i zwraca `sessionId` oraz `signatureDigestSha256` (opis niżej) |
| `POST /v1/pdf/sign/finish`  | wstawia znacznik czasu (lub nie) i kończy podpis; zwraca podpisany PDF (opis niżej)               |
| `GET /v1/pdf/signer`        | część publiczna tożsamości demonstracyjnej (certyfikat, urząd certyfikacji)                       |

Błędy mają postać `{ "code", "message" }`: `409` (`external_disabled`, `db_hash_mismatch`) i `422` (`invalid_request`).
Schematy JSON (draft 2020-12) generowane z modeli Pydantic leżą w `schemas/` (`python scripts/generate_schemas.py`;
test sprawdza, że są aktualne), a przykładowa odpowiedź w `tests/data/usernames-search.sample.json` jest używana w testach
Pythona i klienta w Node.

### `POST /v1/usernames/search`

Żądanie (`usernames-search.v1`): `username` (do 64 znaków, bez białych znaków i `/ ? # @ :`), `database` (`fixture` albo
`upstream`), opcjonalnie `deniedHostSuffixes` (dodatkowe hosty, których nie wolno kontaktować), `tags` (podzbiór
`crypto`, `finance`, `pl`, `social`, `coding`, `messaging`) i `timeoutSeconds` (1–30). Pola spoza schematu są odrzucane.

Odpowiedź: `service` (wersje usługi, Maigreta, socid-extractora i Pythona), `database` (`id`, `sha256`, liczba serwisów,
wybranych i wykluczonych polityką), `policy`, `results` (po jednym wpisie na serwis) i `requests` (dziennik żądań).
Status serwisu to jeden z: `found`, `not_found`, `blocked`, `login_wall`, `captcha`, `unknown`, `illegal`, `skipped`.
**Bariera ani niepowodzenie nigdy nie jest „brakiem profilu”:** 403, 429, strona z CAPTCHA lub wyzwaniem
przeglądarki, cenzura → `blocked`/`captcha` (z powodem, np. `rate_limited`); ściana logowania → `login_wall`;
przekroczony czas, błąd połączenia, 5xx → `unknown`; odmowa strażnika sieci → `skipped`. Po barierze nie ma ponowień ani
obejść (`retries=0`; 429 to jedno żądanie). Trafienie (`found`) to **kandydat na konto, nie powiązanie**: ta sama nazwa
na innym serwisie może należeć do kogoś innego.

Dziennik `requests`: metoda (`GET`), adres rzeczywisty (`url`) i logiczny (`logicalUrl`, adres prawdziwego serwisu, gdy
żądanie poszło na stronę testową), host, serwis, `containsIdentifier: true`, `allowed`/`denyReason`, czasy, status
HTTP, wybrane nagłówki, skrót treści oraz treść (`bodyBase64`, do 1 MiB) tylko dla serwisów ze statusem `found` i dla
barier. Węzeł Node scala ten dziennik z dziennikiem ruchu wychodzącego (`recordDelegated`) i zapisuje przechwycenia.

## Zasady (reguły wyzwania)

- **Maigret jako biblioteka** (`maigret.search`, `MaigretDatabase`), nigdy przez CLI: bez `--ai`, bez autoaktualizacji
  bazy, bez samokontroli serwisów, bez przeglądarki, bez interfejsu WWW, bez raportów. Przypięte `maigret==0.6.6` i
  `socid-extractor==0.1.2` (socid-extractor zawsze z `use_ai_fallback=False`; `links` czytane przez `json.loads` lub
  `ast.literal_eval`, nigdy `eval`).
- **Wykluczone pakiety.** Maigret deklaruje zależności od pomocników proxy/SOCKS i podszywania się pod przeglądarkę:
  `aiohttp-socks`, `PySocks` (i pochodny `python-socks`) oraz `curl-cffi`. W `pyproject.toml` są one usunięte z
  rozwiązywania zależności (`override-dependencies` z warunkiem nigdy niespełnionym), więc nie ma ich w `uv.lock` ani w
  obrazie. Z tego samego powodu wykluczono zależności kodu, którego usługa nie uruchamia: `flask` (interfejs WWW),
  `pyvis` i `networkx` (graf), `reportlab` (PDF) oraz `pycountry` (LGPL). `cloudscraper`, `stem`/`torrequest`, Selenium
  i Playwright nie są zależnościami Maigreta ani tego serwisu. `tests/test_no_bypass.py` dowodzi tego: żaden z tych
  pakietów nie jest zainstalowany ani importowalny (także w czystym interpreterze), po załadowaniu Maigreta nie zostaje
  w `sys.modules` żaden zastępnik, a wyszukiwanie z ustawionymi zmiennymi `HTTP_PROXY`/`ALL_PROXY` nie używa proxy.
- **Załadowanie Maigreta** (`maigret_lib.py`). `maigret/checking.py` importuje wykluczone pakiety na poziomie modułu,
  więc import odbywa się raz, z bezczynnymi zastępnikami samych klas wyjątków, usuwanymi z `sys.modules` zaraz po
  imporcie. Następnie ścieżki łamiące zasady są podmieniane na funkcje zgłaszające `ForbiddenPathError`: checkery
  curl-cffi, „Cloudflare webgate” (FlareSolverr), DNS, Tor/I2P i proxy, aktywacja serwisów (token gościa, sonda
  GraphQL X), import ciasteczek, mutacje adresów oraz cały moduł aktualizacji bazy (także pobieranie). Jedyny checker HTTP
  to `GuardedChecker`, wstawiony tam, gdzie Maigret buduje własny (`checking.SimpleAiohttpChecker`).
- **Audyt ścieżek sieciowych Maigreta 0.6.6:** aiohttp (`SimpleAiohttpChecker` → zastąpiony), curl-cffi
  (`CurlCffiChecker` → zablokowany, serwisy z `protection` wykluczone), Cloudflare webgate (zablokowany), `requests` w
  aktualizacji bazy i `load_from_http` (zablokowane), aiodns (`AiodnsDomainResolver` → zablokowany; `check_domains=False`),
  aktywacja serwisów (zablokowana; serwisy z `activation` wykluczone), `--ai` (moduł nie jest importowany).
  Kod serwisu nie importuje `requests`, `httpx` ani `socket`; test sprawdza, że sesję aiohttp otwiera wyłącznie
  `guarded_checker.py`.
- **Polityka serwisów** (`config/policy.json`, `maigret-policy.v1`). Serwis jest odpytywany tylko wtedy, gdy ma
  żądany tag z listy dozwolonych i żaden tag z `tagsDenied` (m.in. `dating`, `porn`, `medicine`, `hacking`, `religion` —
  kategorie szczególne wg art. 9 RODO), nie jest wyłączony, nie używa Tor/I2P/DNS, nie ma `similarSearch`,
  `activation`, `protection`, nie wymaga POST, nie jest na liście `excludedSites` (`Twitter`, `X`) i żaden jego host nie
  jest pod sufiksem z listy RED (`x.com`, `reddit.com`, `facebook.com`, `linkedin.com`, `allegro.pl`, `olx.pl`,
  `gravatar.com`, …) ani z `deniedHostSuffixes` żądania. Wykluczone serwisy są liczone w `database.excludedByPolicy` i nie
  są kontaktowane. Test w Node sprawdza, że lista RED pokrywa wszystkie hosty źródeł RED z `config/sources.yaml`.
- **Przypięta baza.** Baza `upstream` to plik `data.json` z pakietu Maigreta, z przypiętą sumą SHA-256 w `policy.json`;
  inna zawartość → `409 db_hash_mismatch`. Nic nie jest pobierane ani aktualizowane. Baza `fixture`
  (`data/maigret-db/fixture.json`) zawiera syntetyczne serwisy z adresami prawdziwych hostów, które strażnik odwzorowuje
  na stronę testową (`OLCYS_FIXTURE_BASE_URL` + prefiks z `fixtureHostPrefixes`, jak `DEFAULT_HOST_PREFIXES` w Node;
  test w Node sprawdza zgodność); serwis bez odwzorowania dostaje status `skipped`.
- **Zewnętrzne serwisy.** `database: "upstream"` wymaga `OLCYS_OSINT_ALLOW_EXTERNAL=true` (domyślnie `false`) —
  w przeciwnym razie `409 external_disabled`. Przy `false` każdy host poza stroną testową jest odrzucany.
- **`GuardedChecker`** (jedyna ścieżka sieciowa): lista dozwolonych hostów (strona testowa albo hosty wybranych
  serwisów, bez adresów IP), ręczne przekierowania (najwyżej 5, każdy krok sprawdzany i logowany), `trust_env=False`
  (zmienne proxy są ignorowane), brak ciasteczek i proxy, uczciwy `User-Agent` (`OLCYS_USER_AGENT`, domyślnie
  `OLCYS/0.1.0 (OSINT research prototype)`), HEAD wysyłany jako GET, 4 zapytania/s i co najmniej 1 s między zapytaniami do
  tego samego hosta, 4 połączenia, bez ponowień, treść do 1 MiB na odpowiedź i 16 MiB na wyszukiwanie (po zakodowaniu base64 odpowiedź mieści się w limicie 25 MiB klienta; strona ucięta limitem to `unknown` z powodem `body_truncated`, dziennik żądań zostaje pełny), weryfikacja TLS.
  Jedno wyszukiwanie naraz. Maigret loguje adresy z nickiem, więc jego logger jest wyciszony: na stdout nie trafia
  żaden adres.
- **robots.txt (RFC 9309).** Dla każdego hosta (także po przekierowaniu) `GuardedChecker` raz na wyszukiwanie pobiera
  `robots.txt` tą samą, strzeżoną i logowaną ścieżką (z uczciwym `User-Agent`; wpis w dzienniku ma `purpose:
  "robots.txt"` i `containsIdentifier: false`) i czyta go modułem `urllib.robotparser`. Adres wyłączony przez
  robots.txt ma status `skipped` z powodem `robots_disallowed` i nie jest pobierany. Odpowiedź 2xx → obowiązują reguły;
  4xx → brak ograniczeń, z wyjątkiem 429 (limit: host wyłączony do końca wyszukiwania, serwisy `blocked`/`rate_limited`);
  5xx, przekierowanie lub brak odpowiedzi → host wyłączony na to wyszukiwanie (`skipped`, `robots_unavailable`) — tak
  samo jak w `RobotsCache` po stronie Node. Na stronie testowej `/private/` jest wyłączone w robots.txt, a syntetyczny
  serwis `Archiwum` w bazie `fixture` wskazuje tam, więc zawsze kończy się jako `skipped`.
- **Czego usługa nie robi:** nie loguje się, nie rozwiązuje CAPTCHA, nie skanuje hostów, nie rotuje adresów.

## Podpis PDF (PAdES, pyHanko)

Raport PDF/A-3b renderuje Gotenberg po stronie Node; ten serwis tylko go podpisuje. Przebieg (podpis przerwany):

1. `POST /v1/pdf/sign/prepare` `{ pdfBase64, fieldName: "Podpis", reason }` dodaje niewidoczne pole podpisu z
   certyfikacją (DocMDP: wypełnianie formularzy), rezerwuje 32 KiB na CMS, podpisuje lokalnym kluczem demonstracyjnym
   (RSA PKCS#1 v1.5, SHA-256, atrybuty PAdES) i zwraca `{ sessionId, signatureDigestSha256 }`, gdzie skrót to
   SHA-256 wartości podpisu. Sesja żyje w pamięci 10 minut (maks. 8).
2. Worker w Node prosi o znacznik czasu RFC 3161 dla tego skrótu (`TrustedTimestamper`, klient ruchu wychodzącego,
   źródło `timestamping`); w trybie offline lub przy niedostępnej usłudze znacznika nie ma.
3. `POST /v1/pdf/sign/finish` `{ sessionId, timestampTokenBase64 | null }` wstawia znacznik jako atrybut
   niepodpisany (`PrefetchedTimeStamper` sprawdza, że odcisk znacznika równa się skrótowi podpisu) i zwraca
   `{ pdfBase64, signerCertSha256, signedAt, timestamped }`: PAdES B-T albo, bez znacznika, B-B. Wtedy worker kolejkuje
   osobny znacznik `report_pdf` dla skrótu całego podpisanego pliku.

Znacznik w `timestampTokenBase64` może być pełną odpowiedzią RFC 3161 (`TimeStampResp`, w takiej postaci zwraca go
timestamper workera; musi mieć status „granted”) albo samym tokenem CMS.

**Limity rozmiaru** (spójne w całym łańcuchu): PDF do 50 MiB (`PDF_MAX_BYTES`; większy zostaje bez podpisu z ostrzeżeniem
`signing_unavailable`, a usługa odpowiada `413`). Ciało żądania i odpowiedź niosą PDF jako base64 (+33%), więc klient
ruchu wychodzącego w workerze ma dla usług PDF limit odpowiedzi `PDF_MAX_RESPONSE_BYTES` (ok. 67 MiB), a nie domyślne 25 MiB.

Błędy: `410 session_expired` (nieznana lub wygasła sesja), `400 timestamp_mismatch` (znacznik dla innego skrótu; sesja
zostaje, można dokończyć bez znacznika), `400 invalid_pdf`, `413 too_large` (ponad 50 MB), `429` (zbyt wiele sesji),
`503 signing_unavailable` (brak klucza).

**Klucz i certyfikat demonstracyjny.** Przy pierwszym użyciu usługa tworzy w katalogu `OLCYS_SIGNING_DIR` (w compose:
wolumen `signing-keys` zamontowany w `/signing`) samopodpisany urząd certyfikacji i certyfikat RSA-3072 z EKU
`documentSigning`; nazwa zawiera „niekwalifikowany”. **To podpis demonstracyjny, a nie kwalifikowany** — raport i
konsola mówią o tym wprost. Klucz prywatny nigdy nie trafia do repozytorium, obrazu, dziennika ani odpowiedzi API.
Można go utworzyć z wyprzedzeniem: `pnpm signing:init`. Środowisko produkcyjne powinno użyć certyfikatu kwalifikowanego
na module HSM (PKCS#11) — to kolejny krok. Testy tworzą własne, jednorazowe klucze.

## Testy

```bash
docker build --target test -t olcys-osint-test services/osint-py
docker run --rm --network none olcys-osint-test   # pytest z pytest-socket (tylko 127.0.0.1)
```

Testy używają serwera na `127.0.0.1` (odpowiedzi 200, 404, 403, 429, CAPTCHA, ściana logowania, przekroczony czas,
przekierowania, pętla przekierowań), bazy testowej i atrapy strony testowej; nie łączą się z prawdziwą siecią.
Test `test_real_fixture_site` jest pomijany, dopóki nie ustawisz `OLCYS_E2E_FIXTURE_URL` (adres działającej strony
testowej, np. z `pnpm dev:fixture`, oraz `docker run --network host`).

## Wynik dla persony (baza `fixture`)

`fikcyjny_kacper`: Wykop `found`, GitHub i Telegram `not_found`, Keybase `blocked` (syntetyczna strona kontrolna
„ochrona przed botami”), Archiwum `skipped` (`robots_disallowed`), X i serwis randkowy wykluczone polityką i nigdy nieodpytywane; `fikcyjny-kacper`: GitHub `found`.
Przykładowa odpowiedź: `tests/data/usernames-search.sample.json`.
