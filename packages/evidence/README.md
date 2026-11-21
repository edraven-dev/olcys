# @olcys/evidence

Magazyn plików adresowany treścią (SHA-256), manifesty, rekordy zabezpieczeń stron zgodne z Protokołem Berkeley, znaczniki czasu RFC 3161 oraz porównywanie kolejnych przebiegów analizy.

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/evidence`.

## Publiczne API

- `FileBlobStore(root)` — niezmienny magazyn plików adresowany SHA-256 (zapis atomowy, weryfikacja przy odczycie).
- `InMemoryBlobStore` — implementacja do testów; `sha256Hex()`; `canonicalJson()` (RFC 8785, z `@olcys/core`).
