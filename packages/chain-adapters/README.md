# @olcys/chain-adapters

Dostawcy danych blockchain za portem `ChainProvider` (Esplora, Etherscan V2, TronGrid). Ten sam kod obsługuje publiczne
API, węzły utrzymywane lokalnie i syntetyczną stronę testową — różni się wyłącznie adres bazowy (`baseUrl`). Każde
zapytanie idzie przez klienta ruchu wychodzącego przebiegu (`ctx.http`): lista dozwolonych hostów, limity, dziennik
z `containsIdentifier`, koperta pochodzenia i kasety.

- **Zależności:** kontrakty `@olcys/core` oraz `yaml` (odczyt konfiguracji). Inne pakiety są dostępne przez porty
  łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/chain-adapters` (bez sieci:
  atrapy klienta oraz strona testowa uruchamiana w procesie na 127.0.0.1).

## Konfiguracja: `config/chain-providers.yaml`

| Dostawca              | `sourceId` (rejestr źródeł) | Adres publiczny                   | Łańcuchy                                     |
| --------------------- | --------------------------- | --------------------------------- | -------------------------------------------- |
| `esplora-mempool`     | `mempool_space` (GREEN)     | `https://mempool.space/api`       | `bitcoin`                                    |
| `esplora-blockstream` | `blockstream_esplora`       | `https://blockstream.info/api`    | `bitcoin` (zapasowy)                         |
| `etherscan-v2`        | `etherscan_v2` (AMBER)      | `https://api.etherscan.io/v2/api` | `evm:1`, `evm:137`, `evm:42161`, `evm:59144` |
| `trongrid`            | `trongrid` (AMBER)          | `https://api.trongrid.io`         | `tron`                                       |

- `sourceId` musi istnieć w sekcji `providers:` pliku `config/sources.yaml`; źródła RED są odrzucane przy wczytaniu.
- Klucze API wyłącznie ze zmiennych środowiskowych (`ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`); wysyłane tylko, gdy są
  ustawione, i zawsze maskowane w dzienniku i kasetach (`apikey`, nagłówek `TRON-PRO-API-KEY`).
- **Wdrożenie własne:** zmiana `baseUrl` na własny Esplora/electrs (Bitcoin Core + Blockstream electrs), zgodny
  z Etherscan backend lub indeksator TRC-20 przy java-tron; host trafia do `config/sources.yaml`.
- **Demonstracja (offline):** `withFixtureSite(configs, FIXTURE_SITE_URL, manifest.hostPrefixes)` przepina adresy na
  ścieżki strony testowej, np. `mempool.space/api` → `/chain/esplora/api`.

## Publiczne API

```ts
loadChainProviderConfig(yamlText, { providers }) → ChainProviderConfig[]
withFixtureSite(configs, fixtureBaseUrl, hostPrefixes) → ChainProviderConfig[]
createChainProviderRegistry(configs, { env? }) → ChainProviderRegistry   // forChain(chain, enabledSources)
runChainFetch(plan, registry, ctx, { enabledSources, defaultMaxPages?, unknownEvmChains?, tips? }) → ChainFetchResult
// plan: { address, want?: { summary, transfers, utxo, code }, maxPages? }[]   (code domyślnie dla EVM i TRON)
// wynik: tips, summaries, transfers, utxoTxs, codes (z providerId dostawcy, który zwrócił kod), outcomes (status na
//        adres i dostawcę; codeError, gdy nie udało się odczytać tylko kodu — historia jest pobierana dalej),
//        resolved (evm:unknown)
```

Pojedyncze adaptery i funkcje czyste: `createEsploraProvider`, `createEtherscanProvider`, `createTronGridProvider`,
`mapEsploraTx`, `deriveTransfers`, `mapEtherscanRows`, `classifyEtherscan`, `classifyEthCall`, `mapTrc20Items`,
`requestJson`,
`baseUnitsToDecimal`, `ChainProviderError` (rodzaje: `blocked`, `rate_limited`, `replay_miss`, `egress_denied`, …).

## Zachowanie

- **Kolejność i powtórzenia:** zapytania wykonywane po kolei (deterministyczny dziennik i kasety). HTTP 429/503
  obsługuje klient ruchu wychodzącego; tu ponawiane jest tylko dławienie zwracane jako HTTP 200 (Etherscan „Max rate
  limit reached”): 1 s, 2 s, 4 s ± 20 %. Odpowiedź 403 blokuje dostawcę do końca przebiegu i adres przechodzi do
  kolejnego dostawcy. Brak kasety (`replay_miss`) nigdy nie powoduje zapytania na żywo.
- **Stan łańcucha:** wierzchołek pobierany raz na (dostawca, łańcuch); pozycje powyżej niego są pomijane, a Etherscan
  dostaje `endblock` = wysokość wierzchołka. Zapisywana jest wysokość (bez skrótu bloku — dodatkowe zapytanie).
- **Kwoty:** całkowite jednostki bazowe → `DecimalString` bez liczb zmiennoprzecinkowych; JSON parsowany z zachowaniem
  dokładnego tekstu dużych liczb.
- **Bitcoin (Esplora):** `/address/{a}`, `/address/{a}/txs`, dalsze strony `/address/{a}/txs/chain/{ostatni_txid}` (po
  25 potwierdzonych transakcji); niepotwierdzone pomijane. Wolumeny liczą się z danych UTXO, a widok przelewów
  (`deriveTransfers`) służy regułom kontrahentów.
- **EVM (Etherscan V2):** strumienie `txlist` → `txlistinternal` → `tokentx`, 1000 wierszy na stronę, nowe okno od
  ostatniego bloku po 10 000 wierszy; nieudane transakcje i tokeny o zerowej wartości (spam) pomijane; tokeny
  identyfikowane po kontrakcie, nigdy po symbolu. Odczyty stanu modułu `proxy` z `tag=latest` (stan na zapisany
  wierzchołek) służą klasyfikacji typu adresu (`@olcys/labels`): `eth_getCode` (`getCode`), `eth_getStorageAt`
  (`getStorageAt(address, slot)`) i `eth_call` (`call(address, data)`). Wycofanie wywołania (`execution reverted`) to
  odpowiedź `{ status: 'reverted' }` — negatywny wynik sondy, nie błąd; pozostałe błędy JSON-RPC są błędami dostawcy.
  Każda sonda zawiera adres (`containsIdentifier: true`). Warunki: „Powered by Etherscan.io APIs” przy każdej
  prezentacji danych; plany darmowe tylko do użytku osobistego/badawczego (prototyp).
- **TRON (TronGrid):** przelewy TRC-20 (`/v1/accounts/{a}/transactions/trc20`, stronicowanie `fingerprint`) i saldo
  konta. Pozycje TRC-20 nie mają numeru bloku (`blockHeight: 0`, kolejność według czasu). Kod kontraktu z API węzła:
  `wallet/getcontract?value={a}&visible=true` (`bytecode` → `0x…`; konto bez kontraktu odpowiada `{}` → `0x`; pole
  `Error` → błąd dostawcy). TRON nie ma sond slotów ani wywołań — typ adresu to konto, kontrakt tokena (etykieta lub
  rejestr aktywów) albo kontrakt.
- **`evm:unknown`:** adres bez wskazania sieci jest sprawdzany na łańcuchach z `unknownEvmChains` (domyślnie `evm:1`).

## Ograniczenia MVP

Brak natywnych przelewów TRX i sond stanu kontraktów TRON (tylko kod), brak skrótu bloku wierzchołka, brak trwałej
pamięci podręcznej między przebiegami, brak dostawcy Solana i węzłów Erigon/Otterscan (ścieżka produkcyjna).
