# Zgodność źródeł danych

OŁCyŚ korzysta **wyłącznie z publicznie dostępnych, legalnych źródeł (OSINT)**: bez naruszania regulaminów, bez
logowania na cudze konta, bez danych z wycieków i bez obchodzenia zabezpieczeń (żadnego rozwiązywania CAPTCHA,
omijania mechanizmów antybotowych, rotowania proxy w celu ominięcia blokad ani skanowania).

Rejestr w formie czytelnej dla maszyn to **`config/sources.yaml`** — kod go egzekwuje:

- **GREEN** — dozwolone domyślnie.
- **AMBER** — domyślnie wyłączone; analityk włącza je dla konkretnej sprawy z uzasadnieniem, które jest rejestrowane.
- **RED** — nie można ich włączyć; rejestr kolektorów je odrzuca, a lista dozwolonych hostów nigdy ich nie zawiera.

| Status | Źródła (listopad 2026)                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GREEN  | strona testowa, ENS (własny węzeł RPC), Keybase, Nostr, KRS, CEIDG (token), wykaz podatników VAT, Wayback CDX (tylko odczyt), wyszukiwarka testowa; dostawcy: mempool.space, Blockstream Esplora, API NBP, FreeTSA (tylko skróty)                             |
| AMBER  | strony Bitcointalk dostępne dla gości (≤ 1 zapytanie/s), API BitList, Farcaster/Snapchain, API GitHub, podglądy kanałów Telegram `t.me/s`, API Wykop, Maigret, wyszukiwarki Brave/Mojeek; dostawcy: darmowy plan Etherscan V2, TronGrid, publiczne RPC Solany |
| RED    | X/Twitter, Reddit, Discord, YouTube, Facebook/Instagram, LinkedIn, Linktree, Allegro, OLX, Gravatar (do czasu płatnego planu)                                                                                                                                 |

Narzędzia **celowo niewykorzystywane**, ponieważ łamią zasady: holehe (mechanizm resetu hasła), GHunt (ciasteczka
sesyjne), h8mail i GoSearch (dane z wycieków, łamanie skrótów haseł), Blackbird (punkty rejestracji/logowania, brak
licencji), user-scanner (logi infostealerów), Mr.Holmes (wyszukiwanie w wyciekach), archive.today, Save Page Now dla
stron badanych osób, scrapowanie Google przez SerpApi/Serper/SearXNG, eth-labels jako źródło rozstrzygające
(pozyskane z obchodzeniem zabezpieczeń antybotowych).

Przepływ danych: każde zapytanie do usługi zewnętrznej ujawnia odpytywany identyfikator i nasz adres IP. Dziennik
ruchu wychodzącego rejestruje każde takie ujawnienie (`containsIdentifier`), a wdrożenia produkcyjne powinny
preferować własne węzły, lokalne kopie zbiorów danych i dostawców z umową powierzenia przetwarzania (DPA).

Szczegółowe uzasadnienie statusu każdego źródła znajduje się w polach `complianceNote` i `tosUrl` w `config/sources.yaml`.
