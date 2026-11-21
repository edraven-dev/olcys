# @olcys/evidence

Magazyn plików adresowany treścią (SHA-256), manifesty, rekordy zabezpieczeń stron zgodne z Protokołem Berkeley, znaczniki czasu RFC 3161 oraz porównywanie kolejnych przebiegów analizy.

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/evidence`.

## Publiczne API

- `FileBlobStore(root)` — niezmienny magazyn plików adresowany SHA-256 (zapis atomowy, weryfikacja przy odczycie).
- `InMemoryBlobStore` — implementacja do testów; `sha256Hex()`; `canonicalJson()` (RFC 8785, z `@olcys/core`).
- `diffRuns(before, after)` — porównanie dwóch przebiegów: fakty porównywane według `(platforma, lokalizator,
  właściwość)` dają zdarzenia `ADDED`, `REMOVED` i `VALUE_CHANGED`; zmiana właściwości z adresem portfela ma znacznik
  `wallet` (alert podmiany portfela). Fakt nieobecny na stronie zablokowanej, za logowaniem, za CAPTCHA, z błędem lub
  niepobranej jest wstrzymywany (`suppressed`), a nie zgłaszany jako usunięty. Zmiana wyniku powiązania daje
  `SCORE_CHANGED` z przyczyną: dane, algorytm lub oba. Każde zdarzenie ma skrót `keySha256` do idempotentnego zapisu.
