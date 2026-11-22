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
| `ollama`       | 11434         | profil `llm`                          |

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
