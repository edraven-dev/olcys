# Zgodność źródeł danych

OŁCyŚ korzysta **wyłącznie z publicznie dostępnych, legalnych źródeł (OSINT)**: bez naruszania regulaminów, bez
logowania na cudze konta, bez danych z wycieków i bez obchodzenia zabezpieczeń (żadnego rozwiązywania CAPTCHA,
omijania mechanizmów antybotowych, rotowania proxy w celu ominięcia blokad ani skanowania).

Rejestr w formie czytelnej dla maszyn to **`config/sources.yaml`** — kod go egzekwuje:

- **GREEN** — dozwolone domyślnie.
- **AMBER** — domyślnie wyłączone; analityk włącza je dla konkretnej sprawy z uzasadnieniem, które jest rejestrowane.
- **RED** — nie można ich włączyć; rejestr kolektorów je odrzuca, a lista dozwolonych hostów nigdy ich nie zawiera.

| Status | Źródła (listopad 2026)                                                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GREEN  | strona testowa, ENS (własny węzeł RPC), Keybase, Nostr, KRS, CEIDG (token), wykaz podatników VAT, Wayback CDX (tylko odczyt), wyszukiwarka testowa; dostawcy: mempool.space, Blockstream Esplora, API NBP, FreeTSA (tylko skróty), syntetyczne ceny demonstracyjne (plik lokalny) |
| AMBER  | strony Bitcointalk dostępne dla gości (≤ 1 zapytanie/s), API BitList, Farcaster/Snapchain, API GitHub, podglądy kanałów Telegram `t.me/s`, API Wykop, Maigret, wyszukiwarki Brave/Mojeek; dostawcy: darmowy plan Etherscan V2, TronGrid, publiczne RPC Solany                     |
| RED    | X/Twitter, Reddit, Discord, YouTube, Facebook/Instagram, LinkedIn, Linktree, Allegro, OLX, Gravatar (do czasu płatnego planu)                                                                                                                                                     |

Narzędzia **celowo niewykorzystywane**, ponieważ łamią zasady: holehe (mechanizm resetu hasła), GHunt (ciasteczka
sesyjne), h8mail i GoSearch (dane z wycieków, łamanie skrótów haseł), Blackbird (punkty rejestracji/logowania, brak
licencji), user-scanner (logi infostealerów), Mr.Holmes (wyszukiwanie w wyciekach), archive.today, Save Page Now dla
stron badanych osób, scrapowanie Google przez SerpApi/Serper/SearXNG, eth-labels jako źródło rozstrzygające
(pozyskane z obchodzeniem zabezpieczeń antybotowych).

Przepływ danych: każde zapytanie do usługi zewnętrznej ujawnia odpytywany identyfikator i nasz adres IP. Dziennik
ruchu wychodzącego rejestruje każde takie ujawnienie (`containsIdentifier`), a wdrożenia produkcyjne powinny
preferować własne węzły, lokalne kopie zbiorów danych i dostawców z umową powierzenia przetwarzania (DPA).

Szczegółowe uzasadnienie statusu każdego źródła znajduje się w polach `complianceNote` i `tosUrl` w `config/sources.yaml`.

## Wyszukiwarki internetowe

- **Demonstracja i testy:** wyłącznie wyszukiwarka testowa (`mock_search`, GREEN, `OLCYS_SEARCH_MODE=mock` — domyślnie).
  Przeszukuje strony z mapy witryny strony testowej (z poszanowaniem robots.txt) i dopasowuje zapytania lokalnie, więc
  żaden identyfikator nie opuszcza komputera.
- **Brave Search API i Mojeek** (AMBER, płatne za zapytanie): tylko w trybie `OLCYS_SEARCH_MODE=external`, w przebiegach
  `live` lub `replay`, z kluczem ze zmiennej środowiskowej i po włączeniu źródła w sprawie z uzasadnieniem. Każde
  zapytanie ujawnia dostawcy identyfikator i jest odnotowane w dzienniku ruchu (`containsIdentifier: true`). Do produkcji
  zalecany Mojeek z umową DPA (bez podprzetwarzających) i zerową retencją danych na żądanie; Brave oferuje zerową
  retencję tylko w planie Enterprise.
- **Przechowywanie wyników zgodnie z warunkami dostawców:** Brave — tylko w planie niestandardowym
  (`BRAVE_SEARCH_STORAGE_RIGHTS=true`), Mojeek — w planach Business i Enterprise (`MOJEEK_PLAN`; Startup pozwala buforować
  wyniki najwyżej godzinę). W pozostałych przypadkach odpowiedź dostawcy nie jest zapisywana ani nagrywana (tylko jej
  skrót SHA-256 i rozmiar), a w przechwyceniu zostają tylko pozycje i adresy wyników. Czy taka lista adresów jako ślad
  audytowy mieści się w warunkach dostawców, wymaga potwierdzenia prawnego przed wdrożeniem.
- **Nie używamy:** Google Custom Search JSON API (zamknięte dla nowych klientów, koniec działania 2027-01-01), Bing Web
  Search API (wycofane 2025-08-11), scraperów wyników Google (SerpApi, Serper), scrapowania DuckDuckGo (ddgs), silników
  scrapujących SearXNG ani wyszukiwarek zwracających wyniki przez model językowy (Exa, Tavily).
- Skuteczność wyszukiwania dokładnych ciągów adresów kryptowalut opisuje
  [metodyka próby](../methodology/search-exact-address-spike.md) (jeszcze nieprzeprowadzonej).

## Dane łańcuchowe, kursy i ceny

- **Dane łańcuchowe:** każde zapytanie o adres ujawnia ten adres dostawcy (`containsIdentifier: true` w dzienniku).
  Etherscan V2 i TronGrid są AMBER (włączane dla sprawy); Etherscan wymaga dopisku „Powered by Etherscan.io APIs” przy
  prezentacji danych (pole `attribution` w rejestrze), a darmowe plany są tylko do użytku osobistego i badawczego.
  Produkcja: własne węzły (Esplora/electrs, Erigon + Otterscan, java-tron z indeksatorem TRC-20) — zmienia się tylko adres.
- **Kursy walut:** API NBP (GREEN) — kurs średni z tabeli A z ostatniego dnia roboczego przed transakcją (art. 11a
  ustawy o PIT); zapytania ujawniają wyłącznie daty i waluty.
- **Ceny kryptoaktywów:** żadnego API cenowego dla pojedynczych transakcji. Demonstracja: syntetyczne miesięczne ceny
  BTC/ETH z pliku lokalnego (`demo_prices`, oznaczone w każdej wycenie); stablecoiny USD — jawne założenie parytetu 1:1.
  Produkcja: licencjonowane archiwa świec (Kraken OHLCVT po weryfikacji prawnej; Binance Vision odrzucone ze względu na
  licencję CC-BY-NC-SA). CoinGecko Demo i CoinDesk/CryptoCompare nie są używane (brak licencji komercyjnej).
