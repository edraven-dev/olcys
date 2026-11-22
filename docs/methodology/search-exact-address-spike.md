# Próba: wyszukiwanie dokładnych ciągów adresów kryptowalut

> **Status: nie przeprowadzono — brak klucza API.** W tej wersji nie wysłano żadnego zapytania na żywo do Brave Search
> API ani do Mojeek. Poniżej opisano metodę; tabela wyników i rekomendacja zostaną uzupełnione po przeprowadzeniu próby.

## Cel

Sprawdzić, czy wyszukiwarki dostępne przez oficjalne API (Brave Search API, Mojeek) zwracają trafienia dla dokładnych
ciągów adresów kryptowalut (base58, bech32, hex). Od wyniku zależy, czy reguła planera I5 dla identyfikatorów typu
`crypto_address` ma sens także poza wyszukiwarką testową i która postać zapytania działa najlepiej.

## Zasady

- Wyłącznie publiczne adresy z oficjalnych dokumentów i stron (przykłady ze specyfikacji, oficjalne strony darowizn
  projektów open source). **Nigdy** dane persony, sprawy ani osób prywatnych.
- Kontrola negatywna: 4 poprawne adresy wygenerowane przez skrypt próby (BTC bech32, BTC P2PKH, EVM, TRON); klucze są
  odrzucane od razu po wygenerowaniu adresu. Oczekiwany wynik: brak trafień.
- Najwyżej 100 zapytań na dostawcę; tryb `live`, źródła `brave_search` i `mojeek_search` włączone z uzasadnieniem,
  każde zapytanie zapisane w dzienniku ruchu wychodzącego (`containsIdentifier: true`).
- Surowych stron wyników nie zapisujemy, o ile plan dostawcy nie daje prawa do ich przechowywania
  (`BRAVE_SEARCH_STORAGE_RIGHTS`, `MOJEEK_PLAN`); raport zawiera tylko agregaty.
- Strony z wyników nie są pobierane automatycznie; analityk sprawdza ręcznie 3 pierwsze wyniki 3 wybranych zapytań.

## Ciągi testowe i ich pochodzenie

Każdy ciąg jest kopiowany ze strony źródłowej w dniu próby; zapisujemy adres URL strony i datę.

| Ciąg                                                         | Źródło                                          | URL i data             |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------------------- |
| przykładowy adres P2WPKH (mainnet)                           | specyfikacja BIP-173                            | uzupełnić w dniu próby |
| przykładowy adres P2TR                                       | specyfikacja BIP-350                            | uzupełnić w dniu próby |
| 2 adresy z sumą kontrolną EIP-55 i te same 2 małymi literami | przypadki testowe EIP-55                        | uzupełnić w dniu próby |
| 1 przykładowy adres TRON                                     | dokumentacja deweloperska TRON                  | uzupełnić w dniu próby |
| co najmniej 2 adresy darowizn                                | oficjalne strony darowizn projektów open source | uzupełnić w dniu próby |
| 4 kontrole negatywne                                         | wygenerowane przez skrypt próby                 | —                      |

## Postaci zapytań

| Postać             | Brave | Mojeek |
| ------------------ | ----- | ------ |
| `"<adres>"`        | tak   | tak    |
| `<adres>`          | tak   | tak    |
| `inbody:"<adres>"` | tak   | —      |

Brave: `spellcheck=false`, `text_decorations=false`, `result_filter=web`, `country=ALL`. Mojeek: `fmt=json`, bez
`lb`/`rb`. Dokładną frazę buduje `exactPhrase()`, postać `inbody:` — zapytanie niedokładne z gotowym tekstem.

## Mierzone wielkości

Dla każdej pary dostawca × postać zapytania:

- liczba zapytań i liczba zapytań z co najmniej jednym wynikiem;
- **trafienie dokładne** — ciąg występuje w adresie URL, tytule lub fragmencie wyniku (z rozróżnieniem wielkości liter
  dla base58 i bech32, bez rozróżnienia dla hex);
- zapytania zmienione przez dostawcę (`query.altered` w Brave);
- statusy HTTP, mediana czasu odpowiedzi, koszt.

## Wyniki

Nie przeprowadzono (brak klucza API).

| Dostawca | Postać zapytania   | Zapytania | Z wynikami | Trafienia dokładne | Zmienione zapytania | Statusy HTTP | Mediana czasu [ms] | Koszt |
| -------- | ------------------ | --------- | ---------- | ------------------ | ------------------- | ------------ | ------------------ | ----- |
| Brave    | `"<adres>"`        | —         | —          | —                  | —                   | —            | —                  | —     |
| Brave    | `<adres>`          | —         | —          | —                  | —                   | —            | —                  | —     |
| Brave    | `inbody:"<adres>"` | —         | —          | —                  | —                   | —            | —                  | —     |
| Mojeek   | `"<adres>"`        | —         | —          | —                  | —                   | —            | —                  | —     |
| Mojeek   | `<adres>`          | —         | —          | —                  | —                   | —            | —                  | —     |

Kontrole negatywne: — (oczekiwane 0 trafień dokładnych). Ręczna weryfikacja (3 zapytania × 3 pierwsze wyniki): —.

## Rekomendacja

Do czasu przeprowadzenia próby skuteczność wyszukiwania adresów u zewnętrznych dostawców jest **niezweryfikowana**.
Wynik `not_found` dla adresu nie dowodzi, że adres nie występuje w sieci. Po próbie, osobno dla każdego dostawcy:
zostawić albo wyłączyć wyszukiwanie adresów w regułach planera i wybrać najlepszą postać zapytania (obecnie dokładna
fraza `"<adres>"`).

## Jak przeprowadzić próbę

1. Lokalnie (nigdy w repozytorium) ustawić `OLCYS_MODE=live`, `OLCYS_SEARCH_MODE=external`, `BRAVE_SEARCH_API_KEY`
   i `MOJEEK_API_KEY`.
2. Skopiować ciągi testowe ze stron źródłowych, zapisując adres URL i datę.
3. Uruchomić zapytania przez `createBraveSearchProvider` i `createMojeekSearchProvider` (`@olcys/collectors`) z klientem
   ruchu wychodzącego `@olcys/http` w korzeniu kompozycji (`apps/worker`), z włączonymi źródłami i limitem 100 zapytań
   na dostawcę. Skrypt próby nie jest częścią repozytorium, bo próba nie została jeszcze uruchomiona.
4. Wpisać do tabeli wyłącznie agregaty i uzupełnić rekomendację.
