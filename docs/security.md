# Bezpieczeństwo

Opis zabezpieczeń OŁCyŚ w wersji MVP: nagłówki i polityka CSP, dziennik dostępu, dowód braku telemetrii, sekrety
w środowisku i utwardzenie kontenerów.

## Poza zakresem MVP (planowane)

Konta użytkowników i logowanie są **poza zakresem tego MVP i planowane w kolejnej wersji**: konta analityków z rolami,
sesje po stronie serwera oraz ograniczanie liczby prób logowania. Do tego czasu aplikację otwiera się i używa od razu,
bez monitu o tożsamość czy cel. Dostęp można ograniczyć na poziomie wdrożenia (API nasłuchuje na `127.0.0.1`).
Wbudowane zabezpieczenia API to sprawdzanie nagłówków `Host` i `Origin` (ochrona przed DNS rebinding i zapisami z
innych witryn), opisane w `apps/api/src/guard.ts`.

## Nagłówki bezpieczeństwa i CSP

API ustawia nagłówki w jednym haku `onSend`, więc żadna trasa ich nie pominie:

| Nagłówek                                                     | Wartość                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `Content-Security-Policy` (odpowiedzi JSON)                  | `default-src 'none'; frame-ancestors 'none'`                      |
| `X-Content-Type-Options`                                     | `nosniff`                                                         |
| `Referrer-Policy`                                            | `no-referrer`                                                     |
| `Permissions-Policy`                                         | `camera=(), microphone=(), geolocation=(), payment=(), usb=()`    |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin`                                                     |
| `X-Frame-Options`                                            | `DENY`                                                            |
| `Cache-Control`                                              | `no-store`                                                        |
| `Strict-Transport-Security`                                  | tylko przy `OLCYS_HSTS=1`, czyli gdy API jest serwowane przez TLS |

Trasy, które ustawiają własną, ostrzejszą politykę, zachowują ją: pliki dowodowe i eksporty
(`sandbox; default-src 'none'`, zawsze jako pobranie). **Raport HTML** (`/api/runs/:id/report`) ma wbudowane arkusze
stylów, dlatego jego polityka dopuszcza je wyłącznie po skrócie SHA-256 (`style-src 'sha256-…'`), bez
`'unsafe-inline'` i bez żadnych skryptów.

Zbudowana aplikacja webowa (`pnpm --filter @olcys/web build`, a następnie `preview`) wysyła ścisłą politykę
`default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` oraz pozostałe nagłówki z tabeli.
Jedyne poluzowanie dotyczy wyłącznie CSS: biblioteka grafu (Cytoscape) wstrzykuje jeden stały element `<style>`, który
jest dopuszczony wyłącznie po skrócie SHA-256 (`style-src-elem`); bez `'unsafe-inline'`, a `script-src 'self'` bez zmian —
skrypty wbudowane nadal są zablokowane.
Serwer deweloperski Vite nie może jej zastosować (React Refresh wstrzykuje skrypt, HMR otwiera gniazdo), dlatego
dostaje tylko pozostałe nagłówki. Ustawienia: `apps/web/vite.settings.ts`.

## Dziennik dostępu

Tabela `access_log` (migracja `0011_access_log.sql`) rejestruje, **kto** oglądał lub eksportował **którą** sprawę, kiedy
i z jakim wynikiem. Jest dopisywana w tle, bez żadnego monitu przed wyświetleniem:

- **Zdarzenia:** odczyt sprawy i jej uruchomień (`case.view`), uruchomienia i powiązań (`run.view`), dowodów
  (przechwycenia, obserwacje, konta, dziennik wyjść, pliki: `evidence.view`), raportu HTML (`report.view`), eksportów
  (`export.download`) oraz samego dziennika (`audit.view`). Zapisy (tworzenie spraw, uruchomienia) rejestrują się
  osobno w łańcuchu dowodowym i ocenach.
- **Podmiot (`actor`):** etykieta analityka, której API używa przy ocenach analityka (`OLCYS_ANALYST_NAME`), a gdy jej
  nie ma, stały podmiot `local`. Nigdy nie pochodzi z żądania.
- **Cel (`purpose`):** tylko tam, gdzie klient go przesyła (nagłówek `X-Olcys-Purpose`, np. przy pobraniu eksportu);
  w pozostałych przypadkach pole zostaje puste.
- **Niezmienność:** rola `olcys_app` ma wyłącznie `SELECT` i `INSERT` (jawne `GRANT` oraz
  `REVOKE UPDATE, DELETE, TRUNCATE`); próba zmiany lub usunięcia wiersza kończy się błędem uprawnień. Tabela nie ma
  kluczy obcych, by dziennik nie blokował i nie znikał razem z rekordami, których dotyczy.
- **Odczyt:** `GET /api/access-log?caseId=…&actor=…&limit=…` (najnowsze najpierw, limit 1–500).

## Sekrety i logi

- Sekrety pochodzą wyłącznie ze zmiennych środowiskowych. Jedyne wartości domyślne w repozytorium to lokalne,
  deweloperskie hasła z `.env.example` (np. `olcys_app_dev`); klucze zewnętrznych usług są tam puste. Test
  `scripts/security/no-telemetry.test.ts` pilnuje, by domyślne wartości sekretów w `compose.yml` były identyczne z
  `.env.example`, by klucze zewnętrzne były puste, a żaden śledzony plik nie zawierał klucza prywatnego PEM ani tokenu
  GitHub.
- Log żądań API maskuje nagłówki `authorization`, `cookie` i `set-cookie` oraz pola `password`, `token`, `apiKey`;
  rejestruje samą ścieżkę (bez ciągu zapytania, który może zawierać identyfikatory) i nie zapisuje nagłówków żądania.
  Klucze prywatne i frazy odzyskiwania nie są przechowywane ani logowane (ekstraktor adresów usuwa je z pamięci).

## Telemetria wyłączona

Każdy kontener i konfiguracja CI ustawiają opt-outy z bloku telemetrii w `.env.example`: `DO_NOT_TRACK`,
`HF_HUB_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY`, `VLLM_NO_USAGE_STATS`, `OLLAMA_NO_CLOUD`, `NEXT_TELEMETRY_DISABLED`,
`TURBO_TELEMETRY_DISABLED`, `DOTNET_CLI_TELEMETRY_OPTOUT` oraz `NPM_CONFIG_UPDATE_NOTIFIER=false`. W `compose.yml` służy
do tego kotwica YAML `x-telemetry-off` dołączana do każdej usługi.

Dowody w testach (`pnpm test`):

- `scripts/security/no-telemetry.test.ts`: każda usługa `compose.yml` (wszystkie profile), każdy `Dockerfile`, każdy
  workflow CI i `.env.example` ustawiają opt-outy; test pada dla usługi bez `DO_NOT_TRACK`.
- `apps/web/test/build-security.test.ts`: buduje wersję produkcyjną i sprawdza, że `index.html` oraz paczki nie
  odwołują się do żadnego zdalnego hosta (czcionki, skrypty, CDN, analityka), nie mają skryptów ani stylów
  wbudowanych, a serwer `preview` wysyła ścisłą politykę CSP.
- `apps/api/test/security.test.ts`: nagłówki odpowiedzi, skróty stylów raportu, dziennik dostępu i maskowanie logów.

## Utwardzenie kontenerów

W `compose.yml` usługi stałe (`postgres`, `gotenberg`, `fixture-site`, `osint-py`, `ollama`) mają
`security_opt: ["no-new-privileges:true"]` i `cap_drop: [ALL]` (kotwica `x-hardened`). PostgreSQL dodaje z powrotem
tylko `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID` i `SETUID`, których potrzebuje skrypt startowy. `fixture-site` działa
jako użytkownik `node`, a `fixture-site` i `osint-py` mają system plików tylko do odczytu z `tmpfs` na `/tmp`.
Usługi profilu `sandbox` (Esplora, Anvil) mają wyłącznie `no-new-privileges`, bo ich obrazy uruchamiają wiele
procesów z przełączaniem użytkowników i portami uprzywilejowanymi. Konfigurację sprawdza `docker compose config -q`.
Po zmianie warto uruchomić stos i upewnić się, że wszystkie usługi osiągają stan healthy.

Opcjonalny `pgaudit` nie jest częścią tej wersji.
