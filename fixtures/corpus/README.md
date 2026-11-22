# fixtures/corpus/ — syntetyczny korpus do pomiaru wyodrębniania adresów

Deterministyczny, w całości syntetyczny korpus dokumentów (najpierw po polsku) z oznaczonymi wystąpieniami adresów
kryptowalutowych, trudnych negatywów, zaciemnień i sekretów. Służy do pomiaru precyzji i czułości pakietu
`@olcys/address-extractor` oraz porównania z wyrażeniami regularnymi SpiderFoot. Nie istnieje publiczny, oznaczony
korpus stron z adresami, a „głosowanie większością narzędzi” nie jest prawdą wzorcową — dlatego prawda wzorcowa
powstaje razem z dokumentami.

- **Wyłącznie dane syntetyczne.** Adresy powstają z losowych bajtów (skrót klucza, program świadka, 20-bajtowe konto),
  więc nikt nie ma do nich kluczy prywatnych. Nazwy osób i kont są fikcyjne (`fikcyjny_kacper_17`, `example.org`).
  Wektory testowe z dokumentacji (BIP-173, BIP-350, EIP-55, Bitcoin Wiki) występują wyłącznie jako oznaczone
  negatywy (`example`).
- **Żadnych sekretów na dysku.** Szablony i dokumenty zawierają tylko znaczniki `{{SECRET:<rodzaj>:<n>}}`. Benchmark
  wypełnia je w pamięci wartościami wyprowadzonymi z seeda korpusu (klucz WIF, `xprv`, fraza BIP-39 z 12 lub 24 słów,
  64 znaki hex obok słów „klucz prywatny”) i nigdy ich nie zapisuje ani nie loguje. Test
  `test/corpus.generator.test.ts` przeszukuje wszystkie pliki korpusu pod kątem kluczy WIF, `xprv`, ciągów słów BIP-39
  i kluczy hex obok słownictwa kluczy.
- **Licencja:** jak całe repozytorium (licencja projektu nie została jeszcze ustalona); dane są wygenerowane przez
  OŁCyŚ i nie pochodzą z żadnej strony internetowej.

## Polecenia

```bash
pnpm --filter @olcys/address-extractor corpus:generate   # odtwarza pliki korpusu z szablonów i seeda z manifest.json
pnpm --filter @olcys/address-extractor corpus:check      # generuje w pamięci i porównuje z plikami (kod wyjścia 1 przy różnicy)
pnpm --filter @olcys/address-extractor bench             # pomiar → data/bench/<wersja ekstraktora>/report.{json,md}
```

Ten sam seed i ta sama wersja generatora dają identyczne bajty. Szablony (`templates/`) i ten plik są danymi wejściowymi
— po ich zmianie trzeba ponownie uruchomić `corpus:generate`. Generator i benchmark działają bez sieci.

## Zawartość

| Ścieżka                                       | Zawartość                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                               | `schema` (`olcys.extraction-corpus.v1`), `corpusVersion`, `generator`, `seed`, `counts`, `unsupported`, `files` (SHA-256 każdego pliku poza manifestem) |
| `addresses/<sieć>.jsonl`                      | adresy pozytywne: `{ id, chain, subtype, canonical, display, hasChecksum, network: 'mainnet' }`                                                         |
| `negatives/hard-negatives.jsonl`              | trudne negatywy: `{ id, kind, value, derivedFrom?, expected, rejectCode? }`                                                                             |
| `templates/{pl,en}/<nazwa>.<html\|txt\|json>` | szablony z nagłówkiem YAML w komentarzu `<!-- … -->` (tytuł, liczba renderów, sloty z etykietą roli)                                                    |
| `docs/<docId>.{html,txt,json}`                | wyrenderowane dokumenty (znaczniki sekretów pozostają nienaruszone)                                                                                     |
| `ground-truth.jsonl`                          | jeden wiersz na oznaczone wystąpienie (schemat niżej)                                                                                                   |

Kanał obrazów (QR, OCR) nie ma jeszcze plików `images/` — benchmark raportuje go jako `not_run`. Wyniki iocsearcher
(`baselines/iocsearcher.jsonl`) również nie są dołączone (`not_run`).

### Pola `expected` i `kind` trudnych negatywów

- `reject` — wartość musi zostać odrzucona albo w ogóle nie stać się kandydatem; `rejectCode` (jeśli podany) to kod
  odrzucenia, którego oczekujemy (`bech32_variant_mismatch`, `homoglyph_detected`, `tx_hash_like`, `mixed_case`,
  `checksum_invalid`, `uri_token_contract`);
- `testnet` — adres sieci testowej (`tb1…`, `m…`, `n…`, `2…`);
- `example` — wektor z dokumentacji, odrzucany przez listę wykluczeń (`documentation_example`), raportowany osobno;
- `unverifiable` — wartość poprawna co do formatu, której nie da się odróżnić od adresu bez sumy kontrolnej (adres EVM
  jednej wielkości liter z podmienionym znakiem, `0x` + 40 hex niebędące adresem, podzielony adres EVM bez sumy
  kontrolnej) — nie liczy się jako fałszywy alarm, raport podaje osobno, ile z nich wyodrębniono.

Rodzaje (`kind`): podmiana 1 i 2 znaków, zamiana sąsiednich znaków, obcięcie (`corrupt1`, `corrupt2`, `transpose`,
`truncate`), zmiana wielkości liter EIP-55, mieszana wielkość liter bech32, wersja 1 w bech32 i wersja 0 w bech32m,
adresy testnet, homoglify (cyrylica), kontrakt tokena w URI EIP-681 z funkcją `transfer`, skróty `0x` + 64 hex i 64 hex,
MD5, SHA-1, SHA-256, skróty commitów git, UUID, IPFS CIDv0/CIDv1, ciągi w kształcie JWT (bez prefiksu `ey`) i
`token_…`, losowe base58 (32–44 znaki) i base64url (48 znaków), adresy e-mail, nazwy plików z `.eth`. Ciągi
tokenopodobne nie mają prefiksów żadnego dostawcy, żeby skanery sekretów w repozytorium milczały.

### Schemat `ground-truth.jsonl`

| Pole                                            | Znaczenie                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docId`, `occurrence`                           | dokument i numer wystąpienia w kolejności w dokumencie                                                                                                                 |
| `channel`                                       | `text`, `attr` (atrybut HTML), `uri` (URI płatności), `explorer` (odnośnik do eksploratora), `json_ld` (JSON i JSON-LD)                                                |
| `source`                                        | zakres znaków (UTF-16) w pliku dokumentu — dla sekretów zakres znacznika; benchmark przesuwa zakresy po wypełnieniu sekretów                                           |
| `canonical`, `subtype`                          | postać kanoniczna (EVM i bech32 małymi literami) i podtyp (`p2pkh`, `p2sh`, `p2wpkh`, `p2wsh`, `p2tr`, `evm_eip55`, `evm_lower`, `evm_upper`, `tron_base58`)           |
| `chainSet`                                      | wszystkie sieci, na których bajty adresu są poprawne (np. `3…`: Bitcoin, Litecoin, Bitcoin Cash; EVM: każda sieć EVM)                                                  |
| `chain`                                         | oczekiwane przypisanie sieci wynikające z treści (URI, eksplorator, słowo kluczowe) albo domyślne dla formatu                                                          |
| `isValid`, `hasChecksum`                        | czy bajty tworzą poprawny adres sieci głównej i czy format ma sumę kontrolną                                                                                           |
| `obfuscation`                                   | zastosowane zaciemnienia (lista niżej), pusta dla czystego wystąpienia                                                                                                 |
| `role`                                          | etykieta roli ze slotu szablonu (`first_person_owner`, `payment_request`, `donation`, `scam_report`, `warning`, `quote`, `exchange_deposit`, `listing` albo `none`)    |
| `isSecret`, `secretKind`, `secretIndex`         | sekret i numer jego znacznika                                                                                                                                          |
| `expected`, `negativeKind`, `rejectCode`, `ref` | oczekiwany wynik (`positive`, `reject`, `testnet`, `example`, `unverifiable`, `secret`), rodzaj negatywu, oczekiwany kod odrzucenia, identyfikator adresu lub negatywu |

## Szablony

Szablon to dokument HTML, TXT albo JSON z nagłówkiem YAML w komentarzu na początku pliku (usuwanym przy renderowaniu):

```html
<!--
title: Ogłoszenie drobne (styl OLX) z płatnością w kryptowalucie
renders: 12
slots:
  pay: { pool: bitcoin, role: payment_request, chain: net }
  nr: { neg: [uuid, md5] }
-->
<p>Płatność w {{NET:pay}} na adres: {{ADDR:pay}}</p>
<footer>Identyfikator ogłoszenia: {{NEG:nr}}</footer>
```

- `{{ADDR:<slot>}}` — adres z puli (`bitcoin`, `bitcoin.base58`, `bitcoin.bech32`, `evm`, `evm.eip55`, `tron`, `any`, …);
  `{{URI:<slot>}}` — URI płatności BIP-21 albo EIP-681 (także `@<chainId>`, `pay-` i `/transfer?address=`);
  `{{EXPLORER:<slot>}}` — adres strony eksploratora bloków; `{{NET:<slot>}}` — słowo kluczowe sieci (ustala oczekiwaną
  sieć); `{{NEG:<slot>}}` — trudny negatyw wybranego rodzaju; `{{SECRET:<rodzaj>:<n>}}` — znacznik sekretu
  (numerowany kolejno w dokumencie); `{{#ROWS:<min>-<max>}}…{{/ROWS}}` — powtarzany blok; `{{BANNER}}`, `{{NICK}}`,
  `{{DATE}}`, `{{TIME}}`, `{{AMOUNT}}`, `{{KWOTA}}`, `{{PLN}}`, `{{NUM}}`, `{{N}}` — wypełniacze.
- Kontekst znacznika (atrybut, `<pre>`/`<code>`, komórka tabeli, skrypt JSON-LD, tekst, dokument TXT lub JSON) jest
  rozpoznawany z położenia i decyduje o dozwolonych zaciemnieniach. Generator renderuje szablony po kolei, aż pule
  się wyczerpią; szablony `fallback: true` przejmują pozostałe adresy i negatywy, więc każdy adres trafia do korpusu.
- Szablony: 39 polskich i 9 angielskich (ogłoszenia, wątki forum, stopki z darowiznami, ostrzeżenia przed oszustami,
  fałszywe rozdania, kanał w stylu Telegrama, odnośniki do eksploratorów, JSON-LD `DonateAction`, dokumentacja z blokami
  kodu, tabela profilu, cytaty, instrukcja depozytu z tagiem docelowym, listy 60 adresów, odpowiedzi API w JSON,
  notatki i e-maile w TXT, ujawnione frazy seed i klucze).

## Zaciemnienia

Każde zaciemnienie trafia do stałego, oznaczonego podzbioru wystąpień (rozkład wyrównywany przez generator):

| Zaciemnienie                | Sposób                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `spaces4`                   | grupy po 4 znaki rozdzielone spacją                                                                  |
| `newline`                   | podział wierszami w `<pre>` i TXT na fragmenty ≤ 16 znaków                                           |
| `br_split`, `td_split`      | podział na fragmenty ≤ 16 znaków znacznikami `<br>` albo sąsiednimi komórkami `<td>`                 |
| `span_split`                | 2–4 fragmenty w kolejnych elementach `<span>`                                                        |
| `zero_width`, `bidi`        | 1–3 znaki zerowej szerokości albo 1–2 znaki sterujące kierunkiem tekstu wewnątrz adresu              |
| `fullwidth`                 | cały adres znakami pełnej szerokości (Ｂｃ１…)                                                       |
| `entities`                  | 2–3 znaki jako encje HTML (`&#x61;`, `&#97;`)                                                        |
| `percent`                   | 2–3 znaki adresu w URI płatności zakodowane procentowo (`%61`)                                       |
| `defang`                    | odnośnik do eksploratora w tekście zapisany jako `hxxps://host[.]tld/…`                              |
| `homoglyph`                 | jedna litera zamieniona na cyrylicki odpowiednik — wabik, oczekiwane odrzucenie `homoglyph_detected` |
| `attr_only`, `json_ld_only` | adres wyłącznie w atrybucie (`value`, `data-address`) albo wyłącznie w JSON / JSON-LD                |

Podział na fragmenty dotyczy wyłącznie formatów z sumą kontrolną — sklejony adres bez sumy kontrolnej ekstraktor
odrzuca z założenia (`gap_joined_weak_checksum`), co sprawdzają negatywy `split_unchecksummed`.

## Liczebność (manifest)

| Sieć      | Podtypy                                                                                              | Liczba |
| --------- | ---------------------------------------------------------------------------------------------------- | -----: |
| `bitcoin` | `p2pkh` 100, `p2sh` 100, `p2wpkh` 100, `p2wsh` 100, `p2tr` 100 (75 adresów bech32 wielkimi literami) |    500 |
| `evm`     | `evm_eip55` 200, `evm_lower` 150, `evm_upper` 50                                                     |    400 |
| `tron`    | `tron_base58` 300                                                                                    |    300 |

Trudne negatywy: 1 333 (`reject` 1 222, `testnet` 60, `example` 51) — więcej niż 1 200 adresów pozytywnych — oraz
80 wartości `unverifiable`. Sekrety: 252 (`wif` 55, `xprv` 54, `seed_phrase` 90, `hex64_private_key_context` 53).
Dokumenty: 500 (422 HTML, 41 TXT, 37 JSON), oznaczone wystąpienia: 2 897.

Sieci z projektu korpusu, których ekstraktor jeszcze nie obsługuje (Litecoin `L…`/`M…`/`ltc1…`, Dogecoin, Bitcoin Cash
CashAddr, XRP, Solana, Monero, Cardano, TON, Lightning, klucze `xpub`), nie są generowane ani mierzone — lista
z planowaną liczebnością jest w polu `unsupported` manifestu. Stare adresy `1…`/`3…` Litecoin i Bitcoin Cash mają
te same bajty wersji co Bitcoin i są mierzone razem z nim (przypisanie sieci po słowie kluczowym, schemacie URI
lub eksploratorze).
