# @olcys/db

Schemat PostgreSQL, migracje SQL i typowane repozytoria dla magazynu dowodów działającego w trybie tylko do dopisywania (append-only).

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/db`.

## Publiczne API

- `createDb(url)` — instancja Kysely związana ze schematem `olcys`.
- `createMemoryRepositories()` — implementacja tych samych portów w pamięci (testy, demonstracja bez bazy).
- `createSqlRepositories(db)` — implementacje SQL portów repozytoriów z `@olcys/core` (`cases`, `runs`, `evidence`,
  `chain`, `analysis`, `labels`). Dowody są tylko do dopisywania; rola `olcys_app` nie ma praw UPDATE/DELETE.
- `labels.upsert` pomija dokładny ponowny import etykiety; poprawiona wersja rekordu z tego samego zbioru danych jest
  zapisywana jako nowy wiersz, a `labels.list()` zwraca najnowszą wersję (wg `lastmod`) dla każdej kombinacji adresu,
  podmiotu i zbioru.
- `migrate(ownerUrl)` / `pnpm db:migrate` — migracje SQL z `migrations/` (z kontrolą skrótów SHA-256). Historię
  migracji (`schema_migrations`) może zapisywać wyłącznie właściciel schematu — `migrate()` odbiera prawa zapisu
  pozostałym rolom.
- Testy integracyjne wymagają `OLCYS_TEST_DATABASE_URL` i `OLCYS_TEST_DATABASE_URL_OWNER`.
