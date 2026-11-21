# @olcys/db

Schemat PostgreSQL, migracje SQL i typowane repozytoria dla magazynu dowodów działającego w trybie tylko do dopisywania (append-only).

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/db`.

## Publiczne API

- `createDb(url)` — instancja Kysely związana ze schematem `olcys`.
- `createSqlRepositories(db)` — implementacje SQL portów repozytoriów z `@olcys/core` (`cases`, `runs`, `evidence`,
  `chain`, `analysis`, `labels`). Dowody są tylko do dopisywania; rola `olcys_app` nie ma praw UPDATE/DELETE.
- `migrate(ownerUrl)` / `pnpm db:migrate` — migracje SQL z `migrations/` (z kontrolą skrótów SHA-256).
- Testy integracyjne wymagają `OLCYS_TEST_DATABASE_URL` i `OLCYS_TEST_DATABASE_URL_OWNER`.
