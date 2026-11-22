# @olcys/address-extractor

Wykrywa, weryfikuje (sumy kontrolne) i opisuje kontekstem adresy kryptowalutowe w zabezpieczonych treściach; maskuje sekrety (klucze prywatne, frazy seed).

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- `createSecretRedactor()` — implementacja portu `SecretRedactor` z `@olcys/core`: maskuje klucze prywatne i frazy seed
  w dowolnym tekście (np. treści stron przed zapisem przez kolektory); wyniki zawierają rodzaj i pozycję, nigdy wartość.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/address-extractor` (w tym bramka jakości na korpusie syntetycznym, zob. „Pomiar jakości”).
- **Bez sieci:** biblioteka jest czysta i deterministyczna — przyjmuje bajty zabezpieczonej strony i zwraca wynik; niczego nie pobiera, nie loguje i nie zapisuje.

## Publiczne API

- `extractCapture(content, options)` — przetwarza jedno zabezpieczenie (`CaptureContent`: `captureId`, `url`, `finalUrl`, artefakty `html` / `text` / `json` jako bajty z typem MIME) i zwraca `ExtractionResult` z `@olcys/core` (`candidates`, `rejected`, `secrets`, `extractorVersion`) oraz `warnings`. Opcje: `denyList` (wymagana), `newId` (domyślnie UUIDv7 z `@olcys/core`), `maxRejected` (domyślnie 500, ostrzeżenie `rejected_truncated:<n>`). Funkcja jest asynchroniczna, aby kanały obrazów można było dodać bez zmiany wywołań.
- Etap `extract.capture` (`apps/worker`) uruchamia `extractCapture` dla każdego zabezpieczenia o statusie `ok` — w zwykłym przebiegu i w przebiegu `rescore` (z zabezpieczeń przeliczanego przebiegu, bieżącą `EXTRACTOR_VERSION`). Najpierw wyodrębnia wszystko, potem zapisuje: błąd (np. `SecretLeakError`) nie zostawia żadnych wierszy. Powtórne uruchomienie etapu dla tego samego przebiegu nie dubluje wyników. Do logu trafiają wyłącznie liczniki (kandydaci, odrzucenia, sekrety wg rodzaju, czas); sekret opuszcza proces tylko jako `SecretFinding` (rodzaj + zakres), nigdy jako wartość.
- `parseDenyList(yamlText)` — wczytuje `config/rules/deny-list.v1.yaml` (schemat `DenyListSchema` z `@olcys/core`); `createDenyList(config)`, `EMPTY_DENY_LIST`, `EXTRACTION_DENY_KINDS`.
- `validateAddress(value, chain?)` — sprawdza pojedynczy adres (np. identyfikator `crypto_address` wpisany przez analityka): format, sumę kontrolną, postać kanoniczną i zgodność z podaną siecią.
- `redactText(text, secrets, offset?)`, `redactionMarker(kind)` — maskowanie fragmentów tekstu znacznikiem `[REDACTED:<rodzaj>]`.
- `detectRoleCues(windowText, candidateOffset, extra)`, `ROLE_LEXICON`, `LEXICON_VERSION` — reguły wskazówek ról (PL/EN).
- `REJECT_CODES`, `CHECKSUM_BITS`, `DEOBFUSCATION_TRANSFORMS`, `EXTRACTOR_VERSION`, `PATTERNS_VERSION`, `URI_RULES_VERSION`.
- `SecretLeakError` — rzucany, gdy w wyniku znalazłby się fragment sekretu (błąd programu; wyniku nie wolno wtedy zapisać).

```ts
import { readFileSync } from 'node:fs';
import { extractCapture, parseDenyList } from '@olcys/address-extractor';

const denyList = parseDenyList(readFileSync('config/rules/deny-list.v1.yaml', 'utf8'));
const result = await extractCapture(
  { captureId, url, finalUrl, artifacts: [{ kind: 'html', mediaType: 'text/html; charset=utf-8', bytes }] },
  { denyList },
);
```

## Zasady działania

1. **Dekodowanie i widoki.** Kodowanie: BOM → `charset` z typu MIME → `<meta charset>` → UTF-8 (także `windows-1250`, `iso-8859-2`). HTML (parser `parse5` z pozycjami w źródle) daje widoki `visible_text` (tekst widoczny, bloki w osobnych liniach, granice elementów inline jako spacja), `inline_joined` (elementy inline sklejone bez spacji — wykrywa `<span>bc1q</span><span>…</span>`), `attribute` (`href`, `src`, `value`, `title`, `alt`, `data-*` …), `meta` (`<title>`, `<meta content>`) i `json_ld` (wartości tekstowe z `<script type="application/ld+json">`). Artefakty JSON dają widok `json_ld`, a tekstowe — `visible_text`. Każdy segment ma kontekst DOM: kod (`pre`, `code`, `div.code` …), cytat (`blockquote`, `div.quote`), ukrycie, kontener (post, wiadomość, wiersz tabeli, element listy, obiekt JSON), kotwicę (`data-post`, identyfikator wpisu, poprzedzające `a[name]`), odnośnik i etykietę strukturalną (pierwsza komórka wiersza, nagłówek kolumny, `dt`, `label[for]`). Widok ma limit 5 000 000 znaków (`view_truncated`).
2. **Normalizacja z mapą przesunięć.** Kopia do dopasowań powstaje w kolejności: dekodowanie pozostałych encji HTML → dekodowanie `%XX` tylko w kontekstach URI → NFKC dla każdego klastra grafemów → usunięcie znaków o zerowej szerokości i sterujących kierunkiem tekstu → odwrócenie „defangowania” (`[.]`, `(dot)`, `[at]`, `[małpa]`, `hxxp` …) → zamiana homoglifów (cyrylica/greka → ASCII) wyłącznie w długich tokenach mieszanych z ASCII (polskie litery nigdy nie są zamieniane). Każdy znak kopii wskazuje zakres w tekście oryginalnym, więc kandydat zawsze cytuje to, co strona naprawdę pokazała.
3. **Kandydaci.** Ograniczone wzorce (nigdy wewnątrz dłuższego tokenu) dla Bitcoina (`1…`/`3…` base58check, `bc1…` bech32/bech32m), EVM (`0x` + 40 znaków hex) i TRON (`T…`). Łącznik przerw składa adresy podzielone na grupy (np. co 4 znaki, `<br>`; do 23 fragmentów po 2–20 znaków, czyli także najdłuższy adres bech32 w grupach po 4) w obrębie jednego kontenera i nigdy przez sekret. Ciąg `0x` + 64 znaki hex jest skrótem transakcji, nie adresem.
4. **Sekrety.** Wykrywane są klucze WIF, klucze rozszerzone `xprv`, frazy seed (≥ 12 kolejnych słów z jednej listy BIP-39: angielska, hiszpańska, francuska, włoska, czeska, portugalska) oraz 64/128 znaków hex w pobliżu słów „klucz prywatny”, „seed”, „private key” itp. (także w kluczu JSON). Sekret jest maskowany w pamięci; na zewnątrz trafia wyłącznie `SecretFinding` (rodzaj, widok, pozycja). Sekret znaleziony w jednym widoku jest maskowany we wszystkich widokach. Kandydaci i skróty nachodzące na sekret są odrzucani bez raportu, a końcowa kontrola sprawdza, że żaden 12-znakowy fragment sekretu nie występuje w wyniku. Pola kontekstu (fragment, etykieta, nagłówek, kotwica) są dodatkowo sprawdzane tymi samymi detektorami, bo mogą pochodzić z tekstu spoza widoków (klucze JSON, `a[name]`, identyfikatory elementów) — znaleziony sekret jest maskowany (ostrzeżenie `context_secret_redacted:<rodzaj>`), a końcowa kontrola uruchamia detektory na każdym polu wyniku.
5. **Walidacja („sumy kontrolne, nie wyrażenia regularne, decydują”).** Bitcoin: base58check z wersją `0x00` (`p2pkh`) lub `0x05` (`p2sh`), segwit: wersja 0 tylko bech32 (program 20/32 bajty: `p2wpkh`/`p2wsh`), wersje 1–16 tylko bech32m (`p2tr`), zakaz mieszanej wielkości liter. EVM: małe lub wielkie litery bez sumy kontrolnej (`evm_lower`/`evm_upper`), mieszane — tylko poprawne EIP-55 (`evm_eip55`, 1 bit na literę). TRON: base58check z wersją `0x41`. Bramki: dopasowanie wymagające zamiany homoglifów jest zawsze odrzucane (`homoglyph_detected`), dopasowanie sklejone z grup wymaga silnej sumy kontrolnej, a każde przekształcenie zmieniające treść (znaki zerowej szerokości, defang, sklejenie) ustawia `reviewRequired`. Wektory testowe i przykłady z dokumentacji z listy wykluczeń są odrzucane (`documentation_example`). Z nakładających się odczytów zostaje ten z najsilniejszą sumą kontrolną, potem najdłuższy.
6. **Przypisanie sieci** (kaskada — wygrywa pierwszy wynik; formaty jednoznaczne `bc1…` i `T…` kończą od razu z `format_unique`):
   1. jawny identyfikator sieci: EIP-681 `@<chainId>` i schemat URI (`uri_chain_id`), CAIP-10 (`caip10`), prefiks EIP-3770 (`eip3770`);
   2. domena eksploratora bloków (`explorer_domain`), także z `href` odnośnika;
   3. słowo kluczowe w promieniu ±80 znaków w tym samym kontenerze albo w kluczu JSON, atrybucie `data-*` lub etykiecie (`keyword`; równa odległość różnych sieci → pominięcie kroku, `keyword_conflict`); słowa wewnątrz URI i odnośników nie liczą się;
   4. sieć strony (`page_chain`): najpierw ten sam adres w innym miejscu zabezpieczenia z jedną przypisaną siecią (szczegół `same_address`), potem ≥ 2 różne adresy jawnie przypisane do jednej sieci EVM bez sprzeczności albo ≥ 3 różne adresy przypisane słowem kluczowym i co najmniej 2× więcej niż w następnej sieci (wystąpienia jednego adresu w kilku widokach liczą się raz);
   5. w przeciwnym razie `evm:unknown` (`unknown`); adres `1…`/`3…` bez kontekstu → `bitcoin` z listą pozostałych sieci (`ambiguous: …`).
      Znacznik niezgodny z formatem jest pomijany i odnotowany (`marker_mismatch:<znacznik>`). W EIP-681 z funkcją adres docelowy jest kontraktem (odrzucany jako `uri_token_contract: <funkcja>`); tylko przy `/transfer` parametr `address=` jest odbiorcą, przy innych funkcjach (np. `approve`) jest argumentem wywołania, nie odbiorcą. Odnośniki (`href`) są czytane po tej samej normalizacji co widok atrybutów (np. `%40` → `@`), więc wszystkie widoki wskazują ten sam kontrakt.
7. **Kontekst.** Fragment ±200 znaków w obrębie kontenera (sekrety zamaskowane przed przycięciem; baner danych syntetycznych z innego kontenera nigdy nie trafia do fragmentu), etykieta (etykieta strukturalna → nazwa atrybutu `data-*` → ostatni klucz JSON → najbliższy tekst przed adresem zakończony `:`/`-`/`–`), ostatni nagłówek, `inCode`, kotwica, liczba różnych adresów na stronie i liczba wystąpień adresu (gęstość listy liczona osobno dla każdego artefaktu i widoku). Wskazówki ról (tabela niżej) są uporządkowane od najbliższej frazy; negacja (`nie`, `not`, `never`, `nigdy`) w dwóch poprzedzających tokenach wyłącza wskazówkę; `['unclear']`, gdy nic nie pasuje.
8. **Wynik.** To samo wystąpienie widziane w kilku widokach (te same znaki źródła — każdy znak widoku zna swoją dokładną pozycję w dokumencie, także w łańcuchach JSON z sekwencjami ucieczki) jest raportowane raz, a dwa wystąpienia tego samego adresu w jednym węźle tekstu pozostają osobne — priorytet: `visible_text` > `attribute` > `meta` > `json_ld` > `inline_joined`, a odczyt bez sklejania grup ma pierwszeństwo przed sklejonym. Kandydaci w blokach kodu mają widok `code` (pozycje w tekście `visible_text`). Wynik jest deterministyczny (przy stałym `newId` identyczny bajt w bajt).

## Kody odrzuceń

Pole `reason` ma postać `kod` albo `kod: szczegół`.

| Kod                        | Znaczenie                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `checksum_invalid`         | błędna suma kontrolna (`base58check`, `bech32`, `eip55`)                                                            |
| `tx_hash_like`             | 64/128 znaków hex bez kontekstu klucza prywatnego — skrót transakcji lub bloku                                      |
| `homoglyph_detected`       | adres zawiera znaki podobne do liter łacińskich (np. cyrylickie „а”); szczegół: `folds to <adres>`                  |
| `length_invalid`           | niewłaściwa długość po zdekodowaniu                                                                                 |
| `prefix_unknown`           | nieznany bajt wersji lub prefiks                                                                                    |
| `bech32_variant_mismatch`  | wersja świadka niezgodna z wariantem kodowania (BIP-350)                                                            |
| `mixed_case`               | bech32 z mieszaną wielkością liter (BIP-173)                                                                        |
| `testnet`                  | adres sieci testowej                                                                                                |
| `witness_program_invalid`  | błędny program lub wersja świadka segwit                                                                            |
| `unsupported_format`       | format nieobsługiwany                                                                                               |
| `gap_joined_weak_checksum` | adres sklejony z grup bez silnej sumy kontrolnej                                                                    |
| `uri_token_contract`       | kontrakt wywoływany przez URI płatności (EIP-681 z funkcją, np. `/transfer`), nie odbiorca; szczegół: nazwa funkcji |
| `uri_reference_key`        | klucz referencyjny w URI płatności, nie odbiorca                                                                    |
| `documentation_example`    | wektor testowy lub przykład z dokumentacji z listy wykluczeń; szczegół: nazwa wpisu                                 |

## Eksploratory bloków

| Host (ścieżka)                                                                                                                                                                                                                                                              | Sieć                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `etherscan.io`, `eth.blockscout.com` (`/address/`)                                                                                                                                                                                                                          | `evm:1`                                                            |
| `optimistic.etherscan.io`, `optimism.blockscout.com`                                                                                                                                                                                                                        | `evm:10`                                                           |
| `bscscan.com`                                                                                                                                                                                                                                                               | `evm:56`                                                           |
| `gnosisscan.io`, `gnosis.blockscout.com`                                                                                                                                                                                                                                    | `evm:100`                                                          |
| `polygonscan.com`, `polygon.blockscout.com`                                                                                                                                                                                                                                 | `evm:137`                                                          |
| `basescan.org`, `base.blockscout.com`                                                                                                                                                                                                                                       | `evm:8453`                                                         |
| `arbiscan.io`, `arbitrum.blockscout.com`                                                                                                                                                                                                                                    | `evm:42161`                                                        |
| `lineascan.build`                                                                                                                                                                                                                                                           | `evm:59144`                                                        |
| `mempool.space`, `blockstream.info` (`/address/`)                                                                                                                                                                                                                           | `bitcoin`                                                          |
| `blockchair.com/<sieć>/address/`                                                                                                                                                                                                                                            | bitcoin, bitcoin-cash, litecoin, dogecoin, ethereum, tron, cardano |
| `tronscan.org/#/address/`                                                                                                                                                                                                                                                   | `tron`                                                             |
| `solscan.io/account/`, `explorer.solana.com/address/`, `xrpscan.com/account/`, `livenet.xrpl.org/accounts/`, `blockchair.com/ripple/account/`, `tonviewer.com/`, `tonscan.org/address/`, `cardanoscan.io/address/`, `litecoinspace.org/address/`, `dogechain.info/address/` | sieć eksploratora                                                  |

Odnośniki do transakcji (`/tx/`) niczego nie przypisują. Ekstraktor nigdy nie łączy się z tymi hostami — to tylko tekst zabezpieczonej strony.

## Słowa kluczowe sieci

Bez rozróżniania wielkości liter (po usunięciu polskich znaków diakrytycznych), a oznaczone „(wl)” — z rozróżnieniem:

| Sieć                                                          | Słowa                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `evm:1`                                                       | ethereum, erc20 / erc-20, ether, mainnet, ETH (wl)                             |
| `evm:56`                                                      | bep20 / bep-20, bsc, bnb smart chain, binance smart chain, bnb chain, BNB (wl) |
| `evm:137`                                                     | polygon, matic, POL (wl)                                                       |
| `evm:42161`                                                   | arbitrum, ARB (wl)                                                             |
| `evm:10`                                                      | optimism, op mainnet                                                           |
| `evm:8453`                                                    | base mainnet, base network, sieć base, sieci base, Base (wl)                   |
| `evm:100`                                                     | gnosis, xdai                                                                   |
| `evm:59144`                                                   | linea                                                                          |
| `litecoin`, `bitcoincash`, `bitcoin` (tylko adresy `1…`/`3…`) | litecoin, LTC (wl); bitcoin cash, BCH (wl); bitcoin, BTC (wl)                  |

Słowa spoza EVM (np. `TRC20`) nigdy nie ustalają sieci EVM.

## Leksykon wskazówek ról (`lexicon.v1`)

| Wskazówka            | Znaczenie                             | Przykładowe frazy (PL / EN)                                                                                                                        |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first_person_owner` | autor deklaruje własny portfel        | „mój portfel”, „na mój adres”, „nasz portfel”, „adres mojego portfela” / „my wallet”, „here is my”                                                 |
| `payment_request`    | prośba o wpłatę, sprzedaż, cena       | „wpłać”, „przelej”, „wyślij”, „zapłać”, „sprzedam”, „cena” / „pay to”, „send to”, „price”                                                          |
| `donation`           | darowizna, wsparcie, napiwek          | „wesprzyj”, „darowizna”, „napiwek”, „zrzutka” / „donate”, „tips”, „support us”                                                                     |
| `scam_report`        | zgłoszenie oszustwa                   | „oszust”, „wyłudzenie”, „zgłaszam”, „podejrzany” / „scam”, „phishing”, „fraud”                                                                     |
| `warning`            | ostrzeżenie przed adresem             | „uwaga”, „ostrzegam”, „nie wpłacajcie” / „do not send”, „beware”, „warning”                                                                        |
| `exchange_deposit`   | adres depozytowy giełdy               | „na giełdę”, „adres depozytowy”, „tag docelowy” / „deposit address”, „memo”                                                                        |
| `quote`              | cytat cudzej wypowiedzi               | segment w `blockquote`/`div.quote`, wiersz od `>`, „cytat:”, „napisał:” / „Quote from:”, „wrote:”                                                  |
| `listing`            | lista adresów, przykład, dokumentacja | „przykład”, „dokumentacja”, „lista adresów” / „example”, „BIP-173”, „rich list”; ≥ 10 adresów w kontenerze albo > 50 na stronie i ≥ 3 w kontenerze |
| `unclear`            | brak wskazówek                        | —                                                                                                                                                  |

Samo słowo „test” nie jest wskazówką (każda strona testowa zawiera baner „SYNTHETIC TEST DATA”). Wskazówki są danymi deterministycznymi, nie wynikiem modelu językowego.

## Zakres i ograniczenia

- Obsługiwane sieci: Bitcoin, sieci EVM i TRON. Litecoin, Dogecoin, Bitcoin Cash (CashAddr), XRP, Solana, Monero, Cardano, TON, Lightning, nazwy ENS oraz kanał obrazów (QR/OCR) nie są jeszcze wykrywane.
- Lista wykluczeń (`config/rules/deny-list.v1.yaml`) zawiera wektory testowe BIP-173/BIP-350 i EIP-55 oraz przykłady z dokumentacji; wpisy innych rodzajów (adresy spalania, kontrakty tokenów) obsługuje reguła A8 w pakiecie etykiet.
- Tabela homoglifów to ręcznie wybrany podzbiór danych Unicode TR39 (licencja Unicode-3.0, zob. `docs/compliance/licenses.md`).

## Pomiar jakości (benchmark)

Syntetyczny korpus `fixtures/corpus/` (opis: `fixtures/corpus/README.md`) zawiera 1 200 adresów Bitcoin, EVM i TRON
w 500 dokumentach z 48 szablonów (39 polskich), ponad 1 300 hard negatives, 14 rodzajów zaciemnień i ponad
200 sekretów wypełnianych wyłącznie w pamięci. Metodyka i wyniki: `docs/methodology/extraction-benchmark.md`.

```bash
pnpm --filter @olcys/address-extractor corpus:generate   # odtwarza korpus z szablonów i seedu (deterministycznie)
pnpm --filter @olcys/address-extractor corpus:check      # sprawdza, czy pliki korpusu są aktualne (kod 1 przy różnicy)
pnpm --filter @olcys/address-extractor bench             # raport → data/bench/<EXTRACTOR_VERSION>/report.{json,md}
```

- `bench/` — runner (`runBenchmark`), dopasowanie do prawdy wzorcowej (poziom adresów i wystąpień), metryki
  z przedziałami ufności (bootstrap po dokumentach, stały seed), progi (`bench/thresholds.ts`), raport po polsku
  (`bench/report.ts`, teksty w katalogu `bench/pl.ts`) i linia bazowa SpiderFoot (`bench/baselines/spiderfoot.ts`,
  MIT). Sekrety (`bench/secrets.ts`) powstają z seedu korpusu tylko w pamięci; wyniki, logi i raport są sprawdzane
  pod kątem ich fragmentów, a raport nie zostanie zapisany, jeśli któryś się w nim znajdzie.
- `scripts/corpus/` — generator korpusu (adresy z losowych bajtów, hard negatives, renderowanie szablonów,
  zaciemnienia, manifest z SHA-256 plików).
- Bramka CI: `test/corpus.thresholds.test.ts` (cały korpus, poniżej sekundy) — czyste formaty z sumą kontrolną:
  czułość i precyzja ≥ 99 % dla każdej sieci; zaciemnienia: czułość ≥ 90 %; formaty bez sumy kontrolnej
  z potwierdzeniem: precyzja ≥ 90 %; sekrety: czułość 100 %, 0 wycieków. `test/corpus.generator.test.ts` sprawdza
  determinizm generatora, zgodność plików z manifestem, liczebność i brak sekretów na dysku, a
  `test/bench-scoring.test.ts` — reguły punktacji na celowo wadliwych ekstraktorach.
