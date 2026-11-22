# Komponenty zewnętrzne i ich licencje

Wymóg wyzwania: należy wskazać wszystkie wykorzystane komponenty i ich licencje. Dokument składa się z dwóch części:

- **część generowana** (poniżej, między znacznikami `generated:licenses`): zależności bezpośrednie npm wszystkich
  pakietów, pakiety Pythona, obrazy kontenerów i podsumowanie zależności przechodnich. Generuje ją
  `pnpm licenses:docs --write` z `pnpm-lock.yaml`, `services/osint-py/pyproject.toml`, `compose.yml`, plików Dockerfile
  i `config/compliance/components.yaml`; `pnpm licenses:docs --check` (część `pnpm check`) wykrywa rozjazd. Nie edytuje
  się jej ręcznie: nowa zależność bezpośrednia wymaga polskiego opisu zastosowania w
  `config/compliance/components.yaml`, a nowy obraz kontenera wpisu w sekcji `images` tego pliku;
- **część ręczna** (po znaczniku końcowym): komponenty, których nie opisuje żaden menedżer pakietów (środowisko
  uruchomieniowe, dane, przepisane wyrażenia regularne). Wiersze dodaje się tu ręcznie.

**Kontrole (wszystkie offline, część `pnpm check`):**

- `pnpm compliance:licences` (jedyna bramka licencji npm w `pnpm check`): każdy pakiet z lockfile (także opcjonalne pakiety natywne innych platform) i każdy pakiet
  Pythona względem pełnej polityki (`allowed`, `separateServiceOnly`, `deny`, narzędzia z
  `config/forbidden-tools.yaml`); wyrażenia SPDX są rozstrzygane tak, że `OR` wystarczy spełnić jedną gałęzią, a `AND`
  wymaga wszystkich. Brak licencji, `NOASSERTION`, `SEE LICENSE IN …` i nieznany identyfikator wymagają decyzji
  człowieka: wpisu w `config/compliance/license-exceptions.yaml` (licencji z listy `deny` nie można obejść). Wyjątek zapisuje licencję ustaloną po lekturze tekstu; podlega ona tej samej
  polityce (np. zatwierdzone GPL-3.0-only nadal jest dozwolone tylko jako osobna usługa), a SBOM używa wartości z wyjątku;
- `pnpm compliance:images`: każdy `image:` z `compose.yml` i każde `FROM` z Dockerfile musi być opisane w
  `config/compliance/components.yaml`; licencje GPL/AGPL/LGPL są dopuszczone tylko dla osobnych, niemodyfikowanych usług
  (`separateService: true`);
- `pnpm compliance:sbom --check`: buduje SBOM w pamięci i zawodzi przy naruszeniu bramki (komponent bez licencji lub z
  niedozwoloną). `pnpm compliance:sbom` zapisuje SBOM CycloneDX 1.6 na żądanie do `data/sbom/` (katalog poza
  repozytorium, aby równoległe zmiany zależności nie powodowały konfliktów); generowanie jest deterministyczne (bez
  znacznika czasu i `serialNumber`, posortowane, z sumą SHA-256 lockfile).

`pnpm licenses:check` (license-checker-rseidelsohn, tylko lista `allowed`, tylko zainstalowane pakiety npm) pozostaje jako
ręczne, niezależne sprawdzenie i nie należy do `pnpm check`, ponieważ nie zna wyjątków licencyjnych; `pnpm
compliance:licences` obejmuje ten sam zakres i dodatkowo cały lockfile, pakiety Pythona oraz wyjątki.

**Zakres SBOM.** SBOM npm obejmuje każdy pakiet z `pnpm-lock.yaml` (zależności przechodnie, wersje, skróty
integralności, licencje; pakiety wyłącznie deweloperskie mają `scope: excluded`). Licencje czyta się z zainstalowanych
`package.json`; dla opcjonalnych pakietów natywnych niezainstalowanych na danej platformie służy zatwierdzona tabela
`config/compliance/optional-licences.json` (nieaktualna reguła przerywa generowanie). SBOM Pythona obejmuje zależności
przypięte w `pyproject.toml`; dopóki `services/osint-py/uv.lock` nie jest zatwierdzony, nie zawiera zależności
przechodnich, a licencje pochodzą z zatwierdzonej tabeli w `config/compliance/components.yaml`, nie z zainstalowanych
pakietów. SBOM obrazów kontenerów nie jest generowany (obrazy sprawdza kontrola licencji powyżej).

**Niedozwolone:** licencje własnościowe, BUSL, SSPL, RSAL, Commons Clause, CC-BY-NC (każda klauzula niekomercyjna),
licencje „source-available” (np. Blockscout ≥ v11) oraz licencje wykluczające sektor publiczny (np. QuestPDF Community).
**GPL/AGPL:** wyłącznie jako osobne, niemodyfikowane usługi lub kontenery.

<!-- prettier-ignore-start -->
<!-- generated:licenses:start -->

Poniższe tabele są generowane z `pnpm-lock.yaml`, `services/osint-py/pyproject.toml`, `compose.yml`, Dockerfile i `config/compliance/components.yaml` poleceniem `pnpm licenses:docs` (sprawdzanym w `pnpm check`) — nie edytuj ich ręcznie.

### Status bramki licencyjnej

- Sprawdzone komponenty: 382 (npm: 371, Python: 2, obrazy: 9).
- Wynik: wszystkie komponenty zgodne z polityką licencyjną (`config/licenses.json`).
- Wyjątki licencyjne (`config/compliance/license-exceptions.yaml`): 0.
- SBOM (CycloneDX 1.6) powstają na żądanie poleceniem `pnpm compliance:sbom` (katalog `data/sbom/`, poza repozytorium); opisują je pliki `olcys-npm.cdx.json` i `olcys-osint-py.cdx.json`.

### Zależności bezpośrednie npm

Wszystkie zależności bezpośrednie wszystkich pakietów monorepo (33 pakietów); „(dev)” oznacza zależność deweloperską.

| Komponent | Wersja | Licencja (SPDX) | Zastosowanie | Gdzie |
| --- | --- | --- | --- | --- |
| @noble/curves | 2.4.0 | MIT | podpisy secp256k1 i weryfikacja BIP-137; generator danych syntetycznych | apps/fixture-site (dev), packages/scoring |
| @noble/hashes | 2.4.0 | MIT | SHA-256, RIPEMD-160 i Keccak-256 (sumy kontrolne adresów, BIP-137, skrót wag); generator danych | apps/fixture-site (dev), packages/address-extractor, packages/labels (dev), packages/scoring |
| @safe-global/safe-deployments | 1.37.67 | MIT | adresy singletonów Safe (klasyfikacja typu adresu) | packages/labels |
| @scure/base | 2.4.0 | MIT | bech32/bech32m, base58check i base64 (adresy, BIP-137); generator danych | apps/fixture-site (dev), packages/address-extractor, packages/labels, packages/scoring |
| @scure/bip39 | 2.4.0 | MIT | listy słów BIP-39 do wykrywania i maskowania fraz seed | packages/address-extractor |
| @types/big.js | 7.0.0 | MIT | typy biblioteki big.js | packages/core (dev) |
| @types/node | 26.6.6 | MIT | typy Node.js | root (dev) |
| @types/pg | 8.23.1 | MIT | typy sterownika PostgreSQL | packages/db (dev) |
| @types/react | 19.3.0 | MIT | typy interfejsu (React) | apps/web (dev) |
| @types/react-dom | 19.3.0 | MIT | typy interfejsu (React DOM) | apps/web (dev) |
| @vitejs/plugin-react | 6.3.0 | MIT | wtyczka Vite do budowania interfejsu | apps/web (dev) |
| asn1js | 4.1.0 | BSD-3-Clause | kodowanie i dekodowanie ASN.1/DER (żądania i odpowiedzi znacznika czasu RFC 3161) | packages/evidence |
| big.js | 7.0.1 | MIT | dokładna arytmetyka dziesiętna (kwoty, PLN) | packages/core |
| cron-parser | 5.10.6 | MIT | wyrażenia cron harmonogramu analiz (UTC) | apps/worker |
| cytoscape | 3.35.0 | MIT | graf powiązań (używany bezpośrednio, bez nakładki React; układy wbudowane) | apps/web |
| entities | 9.0.0 | BSD-2-Clause | dekodowanie encji HTML przy normalizacji | packages/address-extractor |
| fastify | 5.12.8 | MIT | API HTTP | apps/api |
| happy-dom | 21.0.4 | MIT | środowisko DOM w testach komponentów (tylko testy) | apps/web (dev) |
| kysely | 0.29.9 | MIT | typowany konstruktor zapytań SQL | packages/db |
| license-checker-rseidelsohn | 5.0.1 | BSD-3-Clause | kontrola licencji zależności npm | root (dev) |
| linkedom | 0.18.15 | ISC | parsowanie HTML zebranych stron (DOM bez przeglądarki) | packages/collectors |
| oxfmt | 0.79.0 | MIT | formatowanie kodu | root (dev) |
| oxlint | 1.94.0 | MIT | lint | root (dev) |
| parse5 | 8.1.1 | MIT | parser HTML z pozycjami w źródle (widoki tekstu) | packages/address-extractor |
| pg | 8.23.1 | MIT | sterownik PostgreSQL (node-postgres) | packages/db |
| pkijs | 4.0.1 | BSD-3-Clause | struktury PKI/CMS: budowa i weryfikacja znaczników czasu RFC 3161 (podpis, łańcuch certyfikatów) | packages/evidence |
| react | 19.3.1 | MIT | interfejs użytkownika | apps/web |
| react-dom | 19.3.1 | MIT | interfejs użytkownika (renderowanie w przeglądarce) | apps/web |
| typescript | 7.0.2 | Apache-2.0 | kontrola typów (tsc, tylko noEmit) | root (dev) |
| vite | 8.3.8 | MIT | budowanie i serwer deweloperski interfejsu | apps/web (dev) |
| vitest | 5.1.1 | MIT | testy | root (dev) |
| yaml | 2.9.1 | ISC | odczyt plików konfiguracyjnych YAML (rejestr źródeł, reguły, wagi, dostawcy danych łańcuchowych) | root (dev), apps/worker, packages/address-extractor, packages/analytics, packages/chain-adapters, packages/collectors, packages/core (dev), packages/labels, packages/scoring |
| zod | 4.6.7 | MIT | walidacja danych wejściowych i konfiguracji | packages/core, packages/llm |

### Pakiety Pythona (services/osint-py)

Zależności bezpośrednie z `pyproject.toml` (przypięte `==`). Plik `uv.lock` nie jest jeszcze zatwierdzony, więc zależności przechodnie nie są ujęte w SBOM; licencje pochodzą z zatwierdzonej tabeli w `config/compliance/components.yaml`.

| Komponent | Wersja | Licencja (SPDX) | Zastosowanie | Gdzie |
| --- | --- | --- | --- | --- |
| fastapi | 0.165.0 | MIT | API serwisu osint-py | services/osint-py |
| uvicorn | 0.54.0 | BSD-3-Clause | serwer ASGI serwisu osint-py | services/osint-py |

### Obrazy kontenerów

Każdy `image:` z `compose.yml` i każde `FROM` z Dockerfile musi mieć wpis w `config/compliance/components.yaml`; licencje GPL/AGPL/LGPL są dopuszczone wyłącznie dla osobnych, niemodyfikowanych usług (`separateService: true`).

| Obraz | Tag | Licencja (SPDX) | Zastosowanie | Gdzie | Osobna usługa |
| --- | --- | --- | --- | --- | --- |
| postgres | 19.0-alpine3.24 | PostgreSQL | baza danych | compose.yml (postgres) | nie |
| gotenberg/gotenberg | 9.9.1 | MIT | HTML → PDF/A (raporty) | compose.yml (gotenberg) | nie |
| node | 26.13.1-alpine | MIT | środowisko uruchomieniowe serwisu strony testowej (fixture-site) | compose.yml (fixture-site) | nie |
| ollama/ollama | 0.40.17 | MIT | lokalne środowisko modeli z API zgodnym z OpenAI (opcjonalne, profil llm) | compose.yml (ollama) | nie |
| ghcr.io/ggml-org/llama.cpp | server-b12602 | MIT | lokalny serwer modeli llama.cpp z API zgodnym z OpenAI (opcjonalny, profil llm-llamacpp) | compose.yml (llamacpp) | nie |
| blockstream/esplora | v3.0.1 | MIT | lokalny węzeł Bitcoin regtest z API Esplora (profil sandbox, dane demonstracyjne) | compose.yml (esplora-regtest) | nie |
| ghcr.io/foundry-rs/foundry | v1.10.0 | MIT OR Apache-2.0 | lokalna sieć EVM (anvil; profil sandbox, dane demonstracyjne) | compose.yml (anvil) | nie |
| ghcr.io/astral-sh/uv | 0.13.9 | MIT OR Apache-2.0 | zarządzanie zależnościami Pythona (etap budowania obrazu osint-py) | services/osint-py/Dockerfile (FROM) | nie |
| python | 3.15.2-slim-trixie | PSF-2.0 | środowisko serwisu OSINT (osint-py) | services/osint-py/Dockerfile (FROM) | nie |

### Zależności przechodnie npm (podsumowanie)

338 pakietów przechodnich; pełna lista z wersjami, skrótami i licencjami jest w SBOM npm (`pnpm compliance:sbom`).

| Licencja (SPDX) | Runtime | Tylko dev | Razem |
| --- | --- | --- | --- |
| MIT | 58 | 139 | 197 |
| ISC | 6 | 55 | 61 |
| Apache-2.0 | 1 | 31 | 32 |
| BSD-2-Clause | 12 | 2 | 14 |
| BlueOak-1.0.0 | 0 | 12 | 12 |
| MPL-2.0 | 0 | 12 | 12 |
| BSD-3-Clause | 5 | 1 | 6 |
| (MIT AND CC-BY-3.0) | 0 | 1 | 1 |
| 0BSD | 0 | 1 | 1 |
| CC-BY-3.0 | 0 | 1 | 1 |
| CC0-1.0 | 0 | 1 | 1 |

<!-- generated:licenses:end -->
<!-- prettier-ignore-end -->

## Komponenty spoza menedżerów pakietów (część ręczna)

| Komponent                                 | Wersja     | Licencja (SPDX)         | Zastosowanie                                                                                                                                   | Gdzie                                   |
| ----------------------------------------- | ---------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Node.js                                   | 26.13.1    | MIT                     | środowisko uruchomieniowe                                                                                                                      | host / `node:26.13.1-alpine`            |
| pnpm                                      | 12.22.0    | MIT                     | menedżer pakietów                                                                                                                              | host                                    |
| Unicode TR39 (confusables)                | —          | Unicode-3.0             | dane: ręcznie wybrana tabela homoglifów (cyrylica/greka)                                                                                       | packages/address-extractor              |
| SpiderFoot (regex)                        | 4.0        | MIT                     | linia bazowa benchmarku adresów: przepisane wyrażenia regularne `sfp_bitcoin`, `sfp_ethereum`                                                  | packages/address-extractor (`bench/`)   |
| Dane MISP (misp-objects, misp-taxonomies) | 2026-11-22 | CC0-1.0 OR BSD-2-Clause | obiekt `coin-address` (v7) oraz taksonomie `estimative-language` (v5), `admiralty-scale` (v5), `tlp` (v10), dołączone dosłownie (eksport MISP) | packages/reporting (`src/export/misp/`) |

Zbiory danych (etykiety, listy sankcyjne, archiwa cen) mają własne licencje; są one zapisywane przy każdej etykiecie
i rekordzie ceny (`LabelProvenance.license`) i podsumowane w `docs/compliance/sources.md`. Demonstracyjne etykiety
(`fixtures/labels/demo-curated.json`) i ceny (`fixtures/prices/demo-prices.v1.json`) są syntetyczne, CC0-1.0.

Dane referencyjne klasyfikacji typu adresu: adresy EntryPoint ERC-4337 (`config/labels/erc4337-entrypoints.v1.yaml`)
to fakty przepisane z notatek wydań eth-infinitism (kod tego repozytorium, objęty licencją GPL, nie jest używany),
a rejestr delegatów EIP-7702 (`config/labels/eip7702-delegates.v1.yaml`) zawiera wyłącznie syntetyczny wpis
demonstracyjny.

Eksporty raportu (STIX 2.1, MISP, CSV) nie dodają żadnej zależności npm. Dane MISP (`packages/reporting/src/export/misp/`) to
oficjalne pliki z repozytoriów MISP (adresy źródłowe i data pobrania: 2026-11-22 w `misp/README.md`) wraz z tekstami licencji; ich licencja (CC0 1.0 lub BSD-2-Clause) jest dozwolona. Schematów JSON
OASIS `cti-stix2-json-schemas` nie dołączono do repozytorium: poprawność strukturalna pakietu STIX jest sprawdzana w
testach własnymi asercjami (identyfikatory, znaczniki czasu, właściwości wymagane).
