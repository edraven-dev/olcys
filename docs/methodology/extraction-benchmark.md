# Metodyka: pomiar wyodrębniania adresów (korpus syntetyczny)

Notatka opisuje, jak mierzymy jakość pakietu `@olcys/address-extractor` — wykrywania, weryfikacji i przypisania sieci
adresów kryptowalutowych oraz maskowania sekretów — i jakie wyniki daje pomiar. Liczby pochodzą z raportu
`data/bench/<wersja ekstraktora>/report.md` wygenerowanego poleceniem
`pnpm --filter @olcys/address-extractor bench` i są tu skopiowane bez zmian (korpus 1.0.0, ekstraktor
`0.1.0+patterns.v1+lexicon.v1+uri.v1`).

## Dlaczego korpus syntetyczny

Nie istnieje publiczny, oznaczony zbiór stron internetowych z adresami kryptowalut, a zgodność kilku narzędzi nie jest
prawdą wzorcową. Korpus (`fixtures/corpus/`, opis w `fixtures/corpus/README.md`) powstaje więc razem z prawdą
wzorcową: generator z ustalonym ziarnem renderuje szablony (39 polskich, 9 angielskich) i zapisuje każde wystąpienie
adresu, trudnego negatywu i sekretu z dokładnym zakresem znaków. Adresy pochodzą z losowych bajtów — nikt nie ma do
nich kluczy. Sekrety istnieją wyłącznie w pamięci podczas pomiaru.

Zakres to sieci, które ekstraktor dziś obsługuje: Bitcoin (`p2pkh`, `p2sh`, `p2wpkh`, `p2wsh`, `p2tr`), sieci EVM
(EIP-55, małe i wielkie litery) i TRON — 1 200 adresów w proporcjach z projektu korpusu (500 / 400 / 300). Pozostałe
rodziny z projektu (Litecoin `L…`/`M…`/`ltc1…`, Dogecoin, Bitcoin Cash CashAddr, XRP, Solana, Monero, Cardano, TON,
Lightning, `xpub`) są w raporcie oznaczone „nieobsługiwane — nie mierzono” i nie wpływają na progi. Kanał obrazów
(QR, OCR) oraz porównanie z iocsearcher mają status `not_run`.

## Jak liczymy

- **Poziom adresów (na dokument):** trafienie (TP), gdy postać kanoniczna adresu z prawdy wzorcowej jest w wyniku
  z siecią należącą do `chainSet` (wszystkich sieci, na których bajty są poprawne); fałszywy alarm (FP) — adres
  w wyniku spoza prawdy wzorcowej; pominięcie (FN) — adres z prawdy wzorcowej, którego brak w wyniku. Wektory
  z dokumentacji (`example`) i wartości niesprawdzalne (`unverifiable`, np. adres EVM jednej wielkości liter
  z podmienionym znakiem) raportujemy osobno, nie jako FP.
- **Poziom wystąpień:** zakres wyniku w źródle dokumentu (z map pozycji widoków) musi pokrywać się z zakresem z prawdy
  wzorcowej z tolerancją ±2 znaki. Na tym poziomie liczymy wyniki według zaciemnienia i kanału, przypisanie sieci
  i role.
- **Przypisanie sieci:** trafność wybranej sieci względem sieci oczekiwanej z treści (URI płatności, eksplorator,
  słowo kluczowe, domyślna dla formatu), osobno dla identyfikatora sieci EVM i adresów `1…`/`3…`.
- **Role:** pierwsza wskazówka roli z wyniku porównana z etykietą slotu szablonu; macro-F1 po rolach obecnych
  w prawdzie wzorcowej.
- **Sekrety:** sekret jest zamaskowany, gdy wynik zawiera `SecretFinding` pokrywający jego zakres. Kontrola wycieków
  serializuje każdy `ExtractionResult`, przechwycone logi i gotowy raport, a następnie szuka każdego 12-znakowego
  fragmentu każdego sekretu.
- **Przedziały ufności:** bootstrap po dokumentach, 1 000 prób, stałe ziarno (raport jest powtarzalny).
- **SpiderFoot:** wyrażenia regularne modułów `sfp_bitcoin` i `sfp_ethereum` przepisane w TypeScript (licencja MIT,
  © Steve Micallef; tekst licencji w nagłówku `packages/address-extractor/bench/baselines/spiderfoot.ts`), uruchomione
  na surowym tekście dokumentu, tak jak SpiderFoot przetwarza pobraną treść strony: base58check tylko dla `1…`/`3…`
  (bez sprawdzania bajtu wersji), bech32 bez walidacji, Ethereum bez EIP-55 i bez prawej granicy dopasowania.

## Progi (bramka CI)

Test `packages/address-extractor/test/corpus.thresholds.test.ts` uruchamia cały korpus (poniżej sekundy) i nie
przechodzi, gdy którykolwiek próg nie jest spełniony. Progi są w `packages/address-extractor/bench/thresholds.ts`.

| Próg                                                                             | Wymaganie                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| czyste formaty z sumą kontrolną, osobno dla Bitcoin, EVM i TRON                  | czułość ≥ 99 % i precyzja ≥ 99 %                                  |
| wystąpienia zaciemnione                                                          | czułość ≥ 90 %                                                    |
| formaty bez sumy kontrolnej potwierdzone URI, eksploratorem lub słowem kluczowym | precyzja ≥ 90 %                                                   |
| sekrety                                                                          | ≥ 200 sekretów 4 rodzajów, czułość maskowania = 100 %, 0 wycieków |
| skróty transakcji, CID IPFS, MD5/SHA/git, ciągi JWT i tokenów                    | 0 kandydatów                                                      |
| wektory BIP-350 (v1 w bech32, v0 w bech32m)                                      | wszystkie odrzucone jako `bech32_variant_mismatch`                |
| SpiderFoot na dokumentach z trudnymi negatywami                                  | precyzja niższa niż OŁCyŚ                                         |

## Wyniki

| Narzędzie                        | Zakres                          | Precyzja |  Czułość |       F1 |
| -------------------------------- | ------------------------------- | -------: | -------: | -------: |
| OŁCyŚ                            | Bitcoin, EVM, TRON              | 100,00 % | 100,00 % | 100,00 % |
| OŁCyŚ                            | Bitcoin, EVM (porównanie)       | 100,00 % | 100,00 % | 100,00 % |
| SpiderFoot (wyrażenia regularne) | Bitcoin, EVM (porównanie)       |  49,57 % |  51,22 % |  50,38 % |
| OŁCyŚ                            | dokumenty z trudnymi negatywami | 100,00 % | 100,00 % | 100,00 % |
| SpiderFoot (wyrażenia regularne) | dokumenty z trudnymi negatywami |  14,98 % |  37,02 % |  21,33 % |

Wszystkie progi są spełnione. Najważniejsze liczby z raportu:

- **Zaciemnienia:** czułość 100 % na 492 zaciemnionych wystąpieniach (spacje co 4 znaki, podział wierszami,
  `<br>`, `<span>` i komórkami tabeli, znaki zerowej szerokości i sterujące kierunkiem, pełna szerokość, encje HTML,
  kodowanie procentowe w URI, „rozbrojone” odnośniki, adres tylko w atrybucie lub w JSON-LD). Wszystkie 60 wabików
  z homoglifami odrzucono jako `homoglyph_detected`.
- **Trudne negatywy:** 0 przyjętych przez OŁCyŚ. SpiderFoot przyjął m.in. 86 z 200 adresów z jednym podmienionym
  znakiem, 47 ze 100 z zamienionymi sąsiednimi znakami, 51 z 80 skrótów `0x` + 64 hex (pierwsze 40 znaków jako
  „adres”), wszystkie 80 wektorów v1/v0 w niewłaściwym wariancie bech32 i wszystkie 60 adresów EIP-55 ze zmienioną
  wielkością liter.
- **Przypisanie sieci:** 99,19 % (1 222 z 1 232); identyfikator sieci EVM 97,56 % (400 z 410), adresy `1…`/`3…`
  100 % (200 z 200). Wszystkie błędy dotyczą ogłoszeń „USDT w sieciach ERC20 i BEP20 na ten sam adres”: ekstraktor
  wybiera najbliższe słowo kluczowe (`evm:56`), choć tekst wskazuje dwie sieci.
- **Role:** macro-F1 81,02 %. Najsłabiej wypadają role wynikające ze struktury, a nie ze słów: pola profilu w tabeli
  i odpowiedzi JSON (właściciel), adresy tylko w atrybutach i JSON-LD, wiersze tabeli z listą 60 adresów (każdy
  wiersz jest osobnym kontenerem) oraz depozyt opisany nagłówkiem tabeli.
- **Sekrety:** 252 z 252 zamaskowanych (`wif` 55, `xprv` 54, `seed_phrase` 90, `hex64_private_key_context` 53),
  0 wycieków.
- **Przepustowość:** około 1 200 dokumentów/s (około 1,2 MB/s) na jednym wątku — wartość zależy od komputera.

## Błąd znaleziony przez pomiar

Łącznik przerw przyjmował najwyżej 12 fragmentów, więc 62-znakowego adresu `p2wsh`/`p2tr` zapisanego w grupach po
4 znaki (16 fragmentów) nie składał — pierwszy pomiar pokazał 14 pominięć z zaciemnieniem `spaces4`. Limit wynosi
teraz 23 fragmenty (najdłuższy adres bech32, 90 znaków, w grupach po 4); dodano test jednostkowy.

## Ograniczenia

- Korpus jest syntetyczny i powstał z tej samej specyfikacji co ekstraktor; mierzy odporność na znane, nazwane
  zaciemnienia, a nie ich częstość na prawdziwych stronach. Próba prawdziwych stron (z oceną dwóch analityków) wymaga
  zgody prawnej i jest poza zakresem.
- Podział adresu obejmuje fragmenty do 16 znaków; łącznik przerw z założenia nie skleja fragmentów dłuższych niż
  20 znaków (np. adresu przełamanego raz w połowie) — tego przypadku nie mierzymy.
- Sklejone adresy bez sumy kontrolnej są z założenia odrzucane (`gap_joined_weak_checksum`); adresy EVM jednej
  wielkości liter z podmienionym znakiem i ciągi `0x` + 40 hex są nie do odróżnienia od adresów (raportowane jako
  niesprawdzalne).
- W dokumentach TXT cały plik jest jednym kontenerem, więc wskazówki ról z sąsiednich wierszy mieszają się.
- Prawda wzorcowa ról to etykiety slotów szablonów, nie ocena analityka.
