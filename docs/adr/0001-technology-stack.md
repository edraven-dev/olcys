# ADR 0001 — Stos technologiczny

- **Status:** przyjęta (2026-11-21)
- **Kontekst:** HackNation 2026, wyzwanie KAS. Wymagania: komponenty open source z udokumentowanymi licencjami; backend
  najlepiej .NET/Java/Node (Go/Python/Rust, jeśli jest to uzasadnione); React/Angular/Vue; PostgreSQL/MySQL/MongoDB/MSSQL;
  model AI wymienialny przez uniwersalne API; żadnych danych ani telemetrii do niezatwierdzonych usług; monorepo.

## Decyzja

| Obszar              | Wybór                                                                                               | Uzasadnienie                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Język i środowisko  | **TypeScript na Node.js 26** (LTS), uruchamiany bezpośrednio dzięki usuwaniu typów (type stripping) | Preferowana rodzina backendu; wszystkie potrzebne biblioteki do adresów kryptowalutowych są dostępne w npm na licencjach MIT/ISC/Apache; jeden język dla API, procesów w tle i interfejsu; brak kroku budowania kodu backendu |
| Kontrola typów      | **TypeScript 7** (`tsc`, natywny)                                                                   | Szybka kontrola całego repozytorium; konfiguracja wymusza `erasableSyntaxOnly`, więc kod działa w Node bez zmian                                                                                                              |
| Menedżer pakietów   | **pnpm 12** (workspaces)                                                                            | Ścisła izolacja zależności, wbudowane polityki bezpieczeństwa łańcucha dostaw (respektowane, nigdy nieobchodzone)                                                                                                             |
| Lint / formatowanie | **oxlint** + **oxfmt** (Oxc)                                                                        | Szybkie, MIT, bez telemetrii                                                                                                                                                                                                  |
| Testy               | **Vitest 5** (projekt na pakiet)                                                                    | Natywny TS, szybki, MIT                                                                                                                                                                                                       |
| API                 | **Fastify 5**                                                                                       | MIT, oparty na schematach, wydajny                                                                                                                                                                                            |
| Zadania w tle       | **pg-boss** na PostgreSQL                                                                           | Bez dodatkowego brokera (bez Redisa — Redis 8 ma licencje RSALv2/SSPLv1/AGPLv3; w razie potrzeby Valkey)                                                                                                                      |
| Baza danych         | **PostgreSQL 19**                                                                                   | Licencja PostgreSQL; role append-only, rekurencyjne CTE dla przepływów środków, `uuidv7()`                                                                                                                                    |
| Frontend            | **React 19 + Vite 8**, interfejs wyłącznie po polsku                                                | Preferowany framework; wszystkie zasoby dołączone do paczki (bez CDN)                                                                                                                                                         |
| Serwis w Pythonie   | **Python 3.15 + uv**, FastAPI                                                                       | Wąsko uzasadniony: Maigret i socid-extractor (MIT) istnieją tylko w Pythonie; pyHanko (MIT) podpisuje PDF                                                                                                                     |
| PDF                 | **Gotenberg 9** (MIT)                                                                               | HTML → PDF/A w kontenerze; unika QuestPDF (wyklucza sektor publiczny) i PdfSharp ≥ 6.5 (AGPL)                                                                                                                                 |
| Lokalny model AI    | **Ollama** (MIT) za API zgodnym z OpenAI; vLLM / llama.cpp wymienne                                 | Zmiana modelu przez `base_url` + identyfikator modelu; `OLLAMA_NO_CLOUD=1`                                                                                                                                                    |
| Obraz PostgreSQL    | **`postgres:19.0-alpine3.24`** (Alpine)                                                             | Mniejszy obraz; polskie sortowanie przez kolacje ICU (`pl-x-icu`); rozszerzenia spoza obrazu (np. pgaudit, Apache AGE) trzeba zbudować ze źródeł we własnym Dockerfile                                                        |

## Konsekwencje

- Kod musi używać wyłącznie składni TypeScript usuwalnej bez transformacji: bez `enum`, `namespace`, właściwości
  parametrów i dekoratorów; importy względne mają rozszerzenie `.ts`; importy samych typów używają `import type`.
- Bez Turborepo (domyślna telemetria) i bez Next.js (domyślna telemetria); wystarczą skrypty workspace pnpm.
- Narzędzia na licencjach AGPL/GPL (np. Browsertrix Crawler, mempool, Fulcrum) mogą działać tylko jako osobne,
  niemodyfikowane usługi.
- Serwis w Pythonie jest wewnętrzną usługą HTTP; poza nim w systemie nie ma kodu w Pythonie.
