# Komponenty zewnętrzne i ich licencje

Wymóg wyzwania: należy wskazać wszystkie wykorzystane komponenty i ich licencje. Tabelę aktualizuje się przy każdym
dodaniu zależności (Definition of Done). Generator SBOM i kontrola licencji utworzą pełny spis zależności
przechodnich; ten plik wymienia komponenty bezpośrednie. Licencje wszystkich zależności npm sprawdza automatycznie
`pnpm licenses:check` (część `pnpm check`) względem listy dozwolonych licencji w `config/licenses.json`.

**Niedozwolone:** licencje własnościowe, BUSL, SSPL, RSAL, Commons Clause, CC-BY-NC (każda klauzula niekomercyjna),
licencje „source-available” (np. Blockscout ≥ v11) oraz licencje wykluczające sektor publiczny (np. QuestPDF Community).
**GPL/AGPL:** wyłącznie jako osobne, niemodyfikowane usługi lub kontenery.

| Komponent                      | Wersja  | Licencja (SPDX)   | Zastosowanie                                                  | Gdzie                              |
| ------------------------------ | ------- | ----------------- | ------------------------------------------------------------- | ---------------------------------- |
| Node.js                        | 26.13.1 | MIT               | środowisko uruchomieniowe                                     | host / `node:26.13.1-alpine`       |
| pnpm                           | 12.22.0 | MIT               | menedżer pakietów                                             | host                               |
| TypeScript                     | 7.0.2   | Apache-2.0        | kontrola typów                                                | devDependency (root)               |
| Vitest                         | 5.1.1   | MIT               | testy                                                         | devDependency (root)               |
| oxlint                         | 1.94.0  | MIT               | lint                                                          | devDependency (root)               |
| oxfmt                          | 0.79.0  | MIT               | formatowanie                                                  | devDependency (root)               |
| license-checker-rseidelsohn    | 5.0.1   | BSD-3-Clause      | kontrola licencji zależności npm                              | devDependency (root)               |
| @types/node                    | 26.6.6  | MIT               | typy Node                                                     | devDependency (root)               |
| zod                            | 4.6.7   | MIT               | walidacja danych wejściowych i konfiguracji                   | packages/core                      |
| big.js                         | 7.0.1   | MIT               | dokładna arytmetyka dziesiętna (kwoty, PLN)                   | packages/core                      |
| yaml                           | 2.9.1   | ISC               | odczyt plików konfiguracyjnych w testach                      | packages/core (dev)                |
| Kysely                         | 0.29.9  | MIT               | typowany konstruktor zapytań SQL                              | packages/db                        |
| pg (node-postgres)             | 8.23.1  | MIT               | sterownik PostgreSQL                                          | packages/db                        |
| Fastify                        | 5.12.8  | MIT               | API HTTP                                                      | apps/api                           |
| React / React DOM              | 19.3.1  | MIT               | interfejs                                                     | apps/web                           |
| Vite                           | 8.3.8   | MIT               | budowanie i serwer deweloperski interfejsu                    | apps/web                           |
| @vitejs/plugin-react           | 6.3.0   | MIT               | budowanie interfejsu                                          | apps/web                           |
| @types/react, @types/react-dom | 19.3.0  | MIT               | typy interfejsu                                               | apps/web                           |
| PostgreSQL                     | 19.0    | PostgreSQL        | baza danych                                                   | compose `postgres:19.0-alpine3.24` |
| Gotenberg                      | 9.9.1   | MIT               | HTML → PDF/A                                                  | compose                            |
| Ollama                         | 0.40.17 | MIT               | lokalne środowisko modeli z API zgodnym z OpenAI (opcjonalne) | compose, profil `llm`              |
| Python                         | 3.15.2  | PSF-2.0           | środowisko serwisu OSINT                                      | `python:3.15.2-slim-trixie`        |
| uv                             | 0.13.9  | MIT OR Apache-2.0 | zarządzanie zależnościami Pythona                             | obraz osint-py                     |
| FastAPI                        | 0.165.0 | MIT               | API serwisu osint-py                                          | services/osint-py                  |
| Uvicorn                        | 0.54.0  | BSD-3-Clause      | serwer ASGI serwisu osint-py                                  | services/osint-py                  |

Zbiory danych (etykiety, listy sankcyjne, archiwa cen) mają własne licencje; są one zapisywane przy każdej etykiecie
i rekordzie ceny (`LabelProvenance.license`) i podsumowane w `docs/compliance/sources.md`.
