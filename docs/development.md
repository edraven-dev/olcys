# Środowisko programistyczne

Przewodnik dla osób rozwijających OŁCyŚ: instalacja, usługi pomocnicze, skrypty i rozwiązywanie problemów.
Architekturę opisuje `docs/architecture.md`, a zasady pracy `AGENTS.md`.

## Wymagania

- Node.js w wersji z `engines` w `package.json` (obecnie >= 26.13.1),
- pnpm w wersji z `packageManager` w `package.json`,
- Docker z wtyczką `docker compose` albo Podman z `podman compose` (patrz „Podman” niżej).

## Szybki start

```bash
cp .env.example .env     # wartości domyślne są wyłącznie lokalne i deweloperskie
pnpm install
pnpm dev:deps            # PostgreSQL, Gotenberg i serwis fixture (czeka na stan healthy)
pnpm db:migrate          # migracje jako rola właściciela schematu
pnpm seed                # sprawa demonstracyjna „Kacper Fikcyjny (demonstracja)”
pnpm dev:doctor          # diagnostyka środowiska (opcjonalnie)
pnpm dev                 # API (:4000), worker i aplikacja webowa (:5173) na hoście
```

Domyślnie `OLCYS_MODE=offline`: poza serwisem fixture nic nie wychodzi do sieci.

## Skrypty

| Polecenie             | Działanie                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:deps`       | `docker compose up -d --wait`: uruchamia usługi i czeka, aż przejdą testy zdrowia.                                    |
| `pnpm dev:deps:down`  | Zatrzymuje usługi; dane (wolumeny) zostają.                                                                           |
| `pnpm db:migrate`     | Stosuje migracje z `packages/db/migrations` (`DATABASE_URL_OWNER`). `pnpm db:status` pokazuje stan.                   |
| `pnpm db:reset --yes` | Usuwa kontener i wolumen PostgreSQL, tworzy czystą bazę (role i schematy z `infra/postgres/init`) i stosuje migracje. |
| `pnpm seed`           | Tworzy sprawę demonstracyjną; ponowne uruchomienie wypisuje „already seeded” i niczego nie tworzy.                    |
| `pnpm dev:doctor`     | Sprawdza środowisko (patrz niżej). Kod wyjścia różny od zera, gdy któraś kontrola zakończy się wynikiem FAIL.         |

### `pnpm db:reset`

Polecenie **niszczy** lokalną bazę (wszystkie sprawy, uruchomienia i dowody). Zawsze najpierw wypisuje dokładny plan
(zatrzymanie i usunięcie kontenera `postgres`, usunięcie wolumenu danych, start świeżej bazy, migracje). Bez flagi
`--yes` odmawia i niczego nie zmienia; `--dry-run` wypisuje plan i kończy bez zmian.
Nazwę wolumenu skrypt odczytuje z rozwiązanej konfiguracji (`<compose> config --format json`), więc uwzględnia `-p`,
`-f`, `COMPOSE_PROJECT_NAME` i `name:` z pliku, a polecenie usuwające wolumen zachowuje prefiks silnika z
`OLCYS_COMPOSE` (np. `docker --context zdalny`). Gdy nazwy nie da się ustalić, skrypt niczego nie usuwa.
Operacja dotyczy wyłącznie usługi `postgres` i jej wolumenu, pozostałe usługi działają dalej.

### `pnpm seed`

Dane są wyłącznie syntetyczne (persona z domeną `example.org`). Seed łączy się jako rola aplikacyjna
(`DATABASE_URL`), a zakres sprawy przechodzi tę samą walidację (`validateCaseScope`) co `POST /api/cases`:
źródła AMBER mają uzasadnienia o długości co najmniej 20 znaków, włączone są dostawcy danych łańcuchowych
(mempool.space, Etherscan, TronGrid), NBP oraz rejestry (CEIDG, biała lista VAT, KRS). Sprawa jest rozpoznawana po
tytule i autorze `seed`, więc kolejne uruchomienia niczego nie dodają. Dwa równoległe uruchomienia w tej samej chwili
mogą utworzyć dwie sprawy; uruchamiaj seed pojedynczo.

### Demo w jednym poleceniu (`pnpm demo`)

Skrypt `scripts/demo/run.ts` prowadzi przez cały syntetyczny scenariusz **działający** lokalny stos: API (`API_URL`,
domyślnie `http://127.0.0.1:4000`) i stronę testową (`FIXTURE_SITE_URL`, domyślnie `http://127.0.0.1:4100`). Akceptuje
wyłącznie adresy pętli zwrotnej (127.0.0.1, `localhost`, `[::1]`); każdy inny adres jest odrzucany przed wysłaniem
jakiegokolwiek żądania. Skrypt niczego nie uruchamia ani nie restartuje.

```bash
cp .env.example .env     # FIXTURE_ALLOW_VARIANT_SWITCH=1 jest już w pliku
pnpm dev:deps            # po zmianie .env uruchom to polecenie ponownie: kontener fixture czyta zmienną przy starcie
pnpm dev                 # API, worker i aplikacja webowa
pnpm demo                # scenariusz + podsumowanie po polsku
pnpm demo --ci           # to samo, ale kod wyjścia 1 i czytelna lista niezgodności, gdy wynik odbiega od oczekiwań
```

Kroki: kontrola zdrowia obu usług (z podpowiedzią, co uruchomić, gdy któraś nie działa); wariant strony testowej `v1`;
utworzenie sprawy persony przez `POST /api/cases` (ten sam ładunek co `pnpm seed`, plus archiwum syntetyczne); uruchomienie 1
z odpytywaniem do końca; wariant `v2`; uruchomienie 2; odczyt wyników przez API i samokontrola z
`fixtures/demo/manifest.json`. Ten plik jest jedynym źródłem oczekiwanych wartości dema (wyniki powiązań, odrzucenia z
regułami, przesłanki wyjścia do fiat, zmiana `profile.bitcoin_address` BTC-1 → BTC-2); adresy bierze z
`fixtures/persona/manifest.json` po nazwach slotów. Podsumowanie pokazuje identyfikator sprawy, powiązania z przedziałami
ocen, odrzucone adresy z powodem, przesłanki wyjścia do fiat, alert zmiany oraz adresy: widok sprawy w interfejsie
(`/sprawy/<id>`) i raport (`/api/runs/<id>/report`).

Jeśli strona testowa odrzuci przełączenie wariantu, ustaw `FIXTURE_ALLOW_VARIANT_SWITCH=1` i uruchom ponownie
`pnpm dev:deps`. Każde uruchomienie `pnpm demo` tworzy nową sprawę. Dane są wyłącznie syntetyczne.

Poza zakresem tej wersji (planowane później): scenariusz z łańcuchami piaskownicy (regtest/Anvil), nagrywanie kaset,
tryb `--mode sandbox` i wyliczanie nazw użytkowników.

### Test akceptacyjny E2E (`pnpm test:e2e`)

Bramka akceptacyjna zgłoszenia: pakiet Playwright prowadzi **polską konsolę** przez siedem obowiązkowych kroków dema i
ponowną analizę z alertem podmiany adresu portfela. Oczekiwane wartości bierze z `fixtures/demo/manifest.json` (adresy po
nazwach slotów z `fixtures/persona/manifest.json`), a etykiety z katalogu `apps/web/src/i18n/pl.ts`.

```bash
pnpm test:e2e                 # cały scenariusz, headless, ok. 1,5 min
pnpm test:e2e --screenshots   # to samo + zrzuty PNG do docs/assets/screenshots/ (1440 px szerokości)
pnpm test:e2e --screenshots --no-mask   # zrzuty bez maskowania — tylko do próby na żywo
```

Test **nie jest** częścią `pnpm check` ani domyślnego `pnpm test` (potrzebuje przeglądarki i trwa ponad minutę); CI
pozostaje bez zmian. Do uruchomienia wystarczy lokalny Chromium: `/usr/bin/chromium` albo ścieżka w `E2E_CHROMIUM`.
Przeglądarki nie są pobierane (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

Stos powstaje w całości w procesach potomnych na wolnych portach pętli zwrotnej: build produkcyjny konsoli
(`vite preview`), API z workerem w procesie na magazynie pamięciowym w trybie `offline` oraz strona testowa z
przełącznikiem wariantu. Bez bazy danych, bez compose; wspólne kontenery i baza deweloperska nie są dotykane. Identyfikatory
procesów są zapisywane, a zatrzymanie odbywa się po PID, nigdy po wzorcu.

Kroki i sprawdzenia:

1. **Dane wejściowe** — sprawa tworzona przez formularz „Nowa sprawa” (tytuł, cel, podstawa prawna, trzy identyfikatory
   persony z kotwicą, zakres źródeł z manifestu; RED wyłączone); widok sprawy pokazuje zablokowany zakres.
2. **Wyszukiwanie OSINT** — przebieg kończy się; w „Źródła i dowody” dziennik połączeń jest niepusty, każdy host to pętla
   zwrotna, żądania ujawniające identyfikator są oznaczone, zabezpieczenia stron mają adres URL i skrót SHA-256.
3. **Wykrywanie adresów** — BTC-1 ma kartę z siecią i identyfikatorem; kandydaci odrzuceni przy walidacji (skrót
   transakcji, przykład z dokumentacji, homoglify) są wymienieni z powodem.
4. **Wskaźnik Pewności** — tabela powiązań równa `expected.v1.links` (wyniki, kolejność, przedziały), komunikat „Wynik
   wspiera ocenę analityka — nie zastępuje jej.”, pewność analityczna osobno, rozwijane uzasadnienie; adresy z zerowym
   wynikiem nie występują wśród powiązań.
5. **Odrzucone przypisania** — reguły A1, A2, A4 (z κ), A8 oraz strona trzecia, słaba tożsamość i próby z podmienionymi
   znakami, z pochodzeniem etykiety.
6. **Aktywność on-chain** — dla ETH-1 dokładnie jedno zdarzenie B1 z kwotą w PLN i tabelą kursów NBP; dla TRON-1 B1, B4
   i B5 zgodnie z manifestem; graf się renderuje.
7. **Źródła i raport** — po przełączeniu strony testowej na `v2` i „Uruchom ponownie” alert „Alert: podmiana adresu
   portfela w profilu” pokazuje BTC-1 → BTC-2 z obydwoma zabezpieczeniami, a BTC-2 ma wynik z manifestu; panel „Oś czasu
   strony” jest widoczny. Zakładka „Raport” pokazuje blok odtwarzalności (wersja wag i skróty), nagłówki „A. Fakty
   źródłowe”, „B. Wyniki obliczeń”, „C. Wnioski wymagające weryfikacji” w tej kolejności oraz listę pobrań ze skrótami
   SHA-256. Strona „Ustawienia” (`/ustawienia`) jest tylko do odczytu.

Zrzuty (`--screenshots`) obejmują `01-sprawy` … `10-ustawienia`, w tym `08-zmiany-os-czasu`.

Przez cały test przeglądarka **nie może** połączyć się z hostem innym niż `127.0.0.1`/`localhost`/`[::1]`: każde takie
żądanie jest przerywane i zapisywane, a test kończy się porażką (podobnie przy błędach strony i konsoli).

**Maskowanie danych w materiałach publikowanych.** Zrzuty ekranu (`--screenshots`) i film (`pnpm demo:video`) są domyślnie
**maskowane**: wstrzyknięty przez Playwright skrypt (aplikacja nie jest zmieniana) zasłania rozmyciem identyfikatory
persony (imię i nazwisko, nick, e-mail, adresy profili), każdy adres kryptowalutowy (bech32/base58, `0x…`, TRON,
również w postaci skróconej), skróty transakcji i dowolne adresy e-mail; pola formularza z takimi wartościami są
rozmywane. Wyniki, przedziały, kody reguł, kwoty w PLN, daty i etykiety pozostają widoczne. Każdy zrzut przechodzi
kontrolę, że w drzewie DOM nie ma niezamaskowanego tekstu persony ani adresu. `--no-mask` służy **wyłącznie** do próby
na żywo; materiały do zgłoszenia, README i prezentacji muszą być maskowane.

#### Film demonstracyjny (`pnpm demo:video`)

```bash
pnpm demo:video            # nagrywa olcys-demo.mp4 w katalogu głównym repozytorium
pnpm demo:video --force    # nadpisuje istniejący plik (domyślnie odmawia)
pnpm demo:video --no-mask  # bez maskowania — tylko próba na żywo
pnpm demo:video --llm      # dodatkowo włącza lokalny model (LLM_ENABLED=true, LLM_MAX_MENTIONS_PER_RUN=1; OVMS z .env.example)
                           # i pokazuje kartę „Sugestia AI — niezweryfikowana”; domyślnie model jest wyłączony
```

Skrypt przechodzi ten sam scenariusz co test akceptacyjny, ale w tempie dla widza: Playwright `recordVideo` 1920×1080,
headless, na lokalnym Chromium, z `slowMo`, płynnym przewijaniem i podświetlaniem kluczowych wartości (wyniki, odrzucenia,
kwota w PLN, alert BTC-1 → BTC-2). Napisy po polsku („Krok N z 7: …”, karta tytułowa i końcowa, znacznik „DANE
SYNTETYCZNE” na każdej klatce) są nakładką dodawaną skryptem przez CSSOM, więc działa przy ścisłym CSP; teksty są w
`e2e/video/captions.pl.ts`. Oczekiwanie na zakończenie analizy jest przyspieszane (z adnotacją na ekranie). Surowe `.webm`
trafia do ignorowanego przez git katalogu `e2e/.video/`, a systemowy `ffmpeg` (zewnętrzne narzędzie, nie zależność)
przekodowuje je do H.264 (30 kl./s, CRF 23, `faststart`). Skrypt drukuje czas każdego kroku i całości i **kończy się błędem,
gdy film trwa dłużej niż 3:00** (plik jest wtedy usuwany). Plik `olcys-demo.mp4` w katalogu głównym repozytorium jest filmem
zgłoszeniowym.

### `pnpm dev:doctor`

Skrypt tylko czyta stan (niczego nie uruchamia ani nie zmienia) i drukuje po jednej linii na kontrolę (`✔`, `!`
ostrzeżenie, `✖` błąd) oraz podsumowanie `OK` lub `FAIL`:

- wersje Node.js i pnpm względem `package.json`,
- obecność pliku `.env`,
- działające polecenie compose oraz stan usług `postgres`, `gotenberg`, `fixture-site` (muszą być `healthy`);
  usługi profili opcjonalnych (`osint`, `llm`, `sandbox`) są raportowane, gdy istnieją,
- porty usług (`POSTGRES_PORT`, `GOTENBERG_PORT`, `FIXTURE_PORT`): wolne albo opublikowane przez działający kontener
  danej usługi (porównanie z portami z `compose ps`); port z `.env` inny niż opublikowany (zmiana bez odtworzenia
  kontenera) albo zajęty przez obcy proces to błąd; porty `API_PORT` i `WEB_PORT` zajęte dają tylko ostrzeżenie (może
  działać `pnpm dev`).

Uwaga: pnpm ma wbudowane polecenie `pnpm doctor`, które ma pierwszeństwo przed skryptem o tej samej nazwie, dlatego
skrypt nazywa się `dev:doctor`.

## Usługi compose

| Usługa         | Port domyślny | Test zdrowia                          |
| -------------- | ------------- | ------------------------------------- |
| `postgres`     | 5432          | `pg_isready`                          |
| `gotenberg`    | 3100          | `GET /health` (curl)                  |
| `fixture-site` | 4100          | `GET /healthz` (wget)                 |
| `osint-py`     | 8090          | profil `osint`; czeka na fixture-site |
| `ollama`       | 11434         | profil `llm`; `ollama list`           |
| `llamacpp`     | 8081          | profil `llm-llamacpp`; `GET /health`  |

Model AI domyślnie nie działa w compose: sugestie korzystają z OpenVINO Model Server uruchomionego na komputerze
(`LLM_BASE_URL=http://localhost:2140/v3`, `LLM_MODEL=qwen3.6-35b-ov`; włączane przez `LLM_ENABLED=true`). Usługa
`ollama` (profil `llm`) jest opcjonalną alternatywą — wtedy `LLM_BASE_URL=http://127.0.0.1:11434/v1`.

## Zamiana modelu

Zmiana modelu to wyłącznie zmiana `.env`: `LLM_BASE_URL` i `LLM_MODEL` (oraz `LLM_CHAT_TEMPLATE_KWARGS`, jeśli serwer
tego wymaga) przenoszą OŁCyŚ między OpenVINO Model Server, Ollamą, llama.cpp i vLLM bez zmian w kodzie. Alternatywne
serwery to profile compose `llm` (Ollama, `http://127.0.0.1:11434/v1`) i `llm-llamacpp` (llama.cpp,
`http://127.0.0.1:8081/v1`, plik GGUF w `data/models/`, zmienne `LLAMACPP_*`); sprawdza je
`docker compose --profile llm --profile llm-llamacpp config -q`. Po zmianie uruchom `pnpm llm:check` (host, model,
modele serwera, skrót, próba ze schematem JSON, opóźnienie; kod wyjścia różny od zera przy błędzie). Szczegóły i tabela
adresów: `packages/llm/README.md`.

Wszystkie porty są wiązane do `127.0.0.1` i konfigurowane w `.env`. Profile: `docker compose --profile osint --profile
llm up -d --wait`. Poprawność pliku sprawdza `docker compose --profile osint --profile llm --profile sandbox config -q`.
Zmienne ograniczające telemetrię (`.env.example`) zostają w każdej konfiguracji kontenerów.

## Podman

Zespół używa emulacji Dockera przez Podmana. Polecenie compose wykrywają skrypty `pnpm db:reset` i `pnpm dev:doctor`
(najpierw `docker compose`, potem `podman compose`); można je wskazać zmienną `OLCYS_COMPOSE`, np.
`OLCYS_COMPOSE="podman compose"`. Skrypt `pnpm dev:deps` wywołuje `docker compose`: przy Podmanie bez aliasu `docker`
uruchom `podman compose up -d --wait`.

Znane różnice:

- **Adres hosta z kontenera:** Docker udostępnia `host.docker.internal`, Podman `host.containers.internal`. Obecny
  `compose.yml` nie wymaga żadnego z nich (usługi widzą się po nazwie, aplikacje działają na hoście), ale gdy kontener
  ma dosięgnąć procesu na hoście, użyj nazwy właściwej dla silnika.
- **Dostawca compose:** `podman compose` jest cienką nakładką na `docker-compose` lub `podman-compose`; format
  wyjścia `ps --format json` bywa różny (tablica albo jeden obiekt na linię), `pnpm dev:doctor` obsługuje oba.
  Komunikat „Executing external compose provider” trafia na stderr i jest niegroźny.
- **Wolumeny:** nazwa wolumenu to zwykle `<nazwa projektu>_postgres-data` (projekt `olcys`); `pnpm db:reset` odczytuje
  ją z `config --format json`, więc zmiana projektu przez `-p` lub `COMPOSE_PROJECT_NAME` jest uwzględniana.
- **Rootless:** porty poniżej 1024 nie są dostępne; domyślne porty projektu są wyższe.

## Rozwiązywanie problemów

- **`.env` brakuje:** `cp .env.example .env`.
- **`port ... taken by another process`:** inny proces zajmuje port; zmień odpowiednią zmienną `*_PORT` w `.env`
  (oraz adresy URL, które jej używają) albo zatrzymaj ten proces.
- **`POSTGRES_PORT is … but the running postgres publishes …`:** port w `.env` zmieniono bez odtworzenia kontenera;
  `pnpm dev:deps` odtworzy go z nowym portem.
- **Usługa `unhealthy` lub `exited`:** `docker compose logs <usługa>`; po zmianie `infra/postgres/init` trzeba
  odtworzyć wolumen (`pnpm db:reset --yes`), bo skrypty inicjalizacji działają tylko przy pierwszym starcie.
- **`DATABASE_URL_OWNER is not set`:** brak `.env`; skrypty ładują go flagą `--env-file-if-exists`.
- **`permission denied` przy seedzie:** `pnpm db:migrate` nie został uruchomiony albo `DATABASE_URL` wskazuje
  inną rolę niż `olcys_app`.
- **`pnpm check` kończy się błędem formatowania:** `pnpm format`.
