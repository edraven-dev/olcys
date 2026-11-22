# Zgodność źródeł danych

OŁCyŚ korzysta **wyłącznie z publicznie dostępnych, legalnych źródeł (OSINT)**: bez naruszania regulaminów, bez
logowania na cudze konta, bez danych z wycieków i bez obchodzenia zabezpieczeń (żadnego rozwiązywania CAPTCHA,
omijania mechanizmów antybotowych, rotowania proxy w celu ominięcia blokad ani skanowania).

Rejestr w formie czytelnej dla maszyn to **`config/sources.yaml`** — kod go egzekwuje:

- **GREEN** — dozwolone domyślnie.
- **AMBER** — domyślnie wyłączone; analityk włącza je dla konkretnej sprawy z uzasadnieniem, które jest rejestrowane.
- **RED** — nie można ich włączyć; rejestr kolektorów je odrzuca, a lista dozwolonych hostów nigdy ich nie zawiera.

Tabele źródeł (według statusu) i lista narzędzi niedozwolonych poniżej są **generowane** z `config/sources.yaml` i
`config/forbidden-tools.yaml` poleceniem `pnpm compliance:sources` (sprawdzanym w `pnpm check`); nie edytuje się ich
ręcznie. Przegląd statusów wykonano w listopadzie 2026 r.

<!-- prettier-ignore-start -->
<!-- generated:sources:start -->

Poniższe tabele są generowane z `config/sources.yaml` i `config/forbidden-tools.yaml` poleceniem `pnpm compliance:sources` — nie edytuj ich ręcznie.

Rejestr: `sources.v1`, SHA-256 `61e7523ca139320e13641fe66df1aa6c65318866aa341e23e091dab37e715b1e`.

### Źródła GREEN

Używane domyślnie (lub po włączeniu w sprawie), bez dodatkowego uzasadnienia.

| Źródło | Rodzaj | Domyślnie włączone | Limit zapytań | Ujawnia identyfikator | Wiarygodność (Admiralty) | Regulamin | Uzasadnienie |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Blockstream Esplora (Bitcoin) (`blockstream_esplora`) | chain_data | nie | 1 / 1 s | tak | A | https://blockstream.com/terms/ | Ten sam kształt interfejsu Esplora REST; zarządzana usługa ma darmowy miesięczny limit. |
| CEIDG API v3 (`ceidg`) | registry | nie | 1 / 4 s | tak | A | https://pliki.biznes.gov.pl/akademia/20250117/HD%20CEIDG%20-%20API%20v3%20HD%20-%20Dokumentacja%20dla%20integrator%C3%B3w%20v1.1.pdf | Oficjalny interfejs; jedyny umożliwiający wyszukiwanie po imieniu i nazwisku (możliwe tezki – NIP jest śledzony tylko przy pojedynczym trafieniu). Wymaga tokenu instytucji (CEIDG_API_TOKEN, tylko w nagłówku, nigdy w dzienniku). Limity: 50 zapytań na 3 minuty i 1000 na godzinę, utrzymywane na poziomie 1 zapytania na 4 s; błędów limitu nie ponawiamy. Warunki są zawarte w oficjalnej dokumentacji interfejsu. |
| Syntetyczne ceny kryptowalut (plik lokalny fixtures/prices) (`demo_prices`) | price_fx | tak | bez sieci | nie | C | brak opublikowanego regulaminu | Zmyślone miesięczne kursy odniesienia BTC/ETH dla syntetycznej persony, czytane z pliku lokalnego; bez sieci i bez identyfikatorów. W każdej wycenie oznaczone jako syntetyczne. Produkcyjnie importujemy licencjonowane archiwa świec (Kraken OHLCVT po przeglądzie prawnym; Binance Vision odrzucone – CC-BY-NC-SA). |
| ENS (przez skonfigurowany węzeł Ethereum / ENSNode) (`ens`) | identity_protocol | tak | 5 / 1 s | tak | A | brak opublikowanego regulaminu | Publiczne wpisy w łańcuchu bloków. Własny węzeł RPC zachowuje prywatność zapytań. Brak odrębnego regulaminu – to otwarty protokół. |
| Syntetyczna witryna testowa OŁCyŚ (`fixture_site`) | fixture | tak | 10 / 1 s | nie | B | brak opublikowanego regulaminu | Syntetyczna persona serwowana lokalnie (apps/fixture-site). Brak danych rzeczywistych; źródło nie łączy się z żadnym zewnętrznym hostem. |
| FreeTSA – znakowanie czasem RFC 3161 (`freetsa`) | timestamping | tak | 1 / 1 s | nie | B | https://freetsa.org/freetsa.html | Poza system wychodzą wyłącznie skróty SHA-256. Tylko do demonstracji (to nie kwalifikowany podmiot); w produkcji kwalifikowany polski podmiot znakowania czasem. Link prowadzi do polityki użytkowania. |
| Gotenberg (renderowanie HTML do PDF/A, usługa lokalna) (`gotenberg`) | internal_service | tak | 2 / 1 s | nie | F | https://github.com/gotenberg/gotenberg/blob/main/LICENSE | Otwarte oprogramowanie (MIT): silnik Chromium/PDF uruchomiony jako lokalny kontener. Otrzymuje gotowy raport (zawiera dane sprawy) i nie ma dostępu do sieci: Chromium jest ograniczony do przesłanych plików (zakotwiczona lista dozwolonych adresów, blokada adresów publicznych i prywatnych, bez JavaScriptu), pobieranie z adresu i webhooki są wyłączone. Nie używa się bibliotek PDF o ograniczonej licencji. Dostęp wyłącznie przez klienta ruchu wychodzącego; nigdy nie jest odtwarzana z kaset ani do nich zapisywana. |
| Keybase – interfejs wyszukiwania (`keybase`) | identity_protocol | tak | 1 / 1 s | tak | A | https://keybase.io/docs/api/1.0/call/user/lookup | Publiczny interfejs wyszukiwania; podpisane adresy kryptowalutowe. Usługa jest tylko utrzymywana, dane głównie sprzed 2020 r. Link prowadzi do dokumentacji interfejsu, nie do regulaminu. |
| KRS Open API (`krs`) | registry | tak | 1 / 1 s | tak | A | https://prs.ms.gov.pl/krs/openApi | Oficjalny interfejs (dane otwarte, CC0); wyszukiwanie wyłącznie po numerze KRS. Czasem zwraca stronę przerwy technicznej ze statusem 200 – zapisujemy to jako błąd, a nie jako pusty rejestr. Numery PESEL nigdy nie są odczytywane. Warunki są zawarte w oficjalnej dokumentacji interfejsu. |
| Lokalny model AI (serwer zgodny z API OpenAI na tym komputerze) (`local_llm`) | ai_model | tak | 2 / 1 s | nie | F | https://github.com/openvinotoolkit/model_server/blob/main/LICENSE | OpenVINO Model Server (Apache-2.0) z modelem o otwartych wagach (Qwen, Apache-2.0) na pętli zwrotnej lub hoście compose; podpowiedzi i odpowiedzi nie opuszczają maszyny. Model tylko podpowiada: sugestie mają zerową wagę w ocenie, dopóki analityk ich nie potwierdzi. Treści ze źródeł z llmAllowed false nigdy nie są wysyłane. Link prowadzi do licencji serwera. |
| mempool.space Esplora REST (Bitcoin) (`mempool_space`) | chain_data | tak | 1 / 1 s | tak | A | https://mempool.space/terms-of-service | Publiczny interfejs z nieujawnionymi limitami na adres IP; ok. 1 zapytania na sekundę. Ujawnia odpytywane adresy; w produkcji używamy własnego Esplora/electrs. |
| Atrapa wyszukiwarki (dane testowe) (`mock_search`) | search | tak | 10 / 1 s | nie | C | brak opublikowanego regulaminu | Przeszukuje mapę witryny syntetycznej (tylko tryby z danymi testowymi, z poszanowaniem robots.txt). Zapytania są dopasowywane lokalnie, więc żaden identyfikator nie opuszcza komputera. Domyślne ustawienie demonstracji (OLCYS_SEARCH_MODE=mock). |
| NBP Web API (kursy walut) (`nbp_api`) | price_fx | tak | 2 / 1 s | nie | A | https://api.nbp.pl/en.html | Bezpłatny interfejs bez klucza, tylko HTTPS; do 93 dni na zapytanie. Zapytania ujawniają wyłącznie daty i waluty. Zasady użycia są w oficjalnej instrukcji interfejsu. |
| Nostr (NIP-05 i przekaźniki) (`nostr`) | identity_protocol | tak | 2 / 1 s | tak | C | brak opublikowanego regulaminu | Otwarty protokół publiczny. NIP-05 wskazuje, ale nie weryfikuje tożsamości; adresy Lightning (lud16) bywają powiernicze. Brak regulaminu – brak jednego operatora. |
| Usługa podpisu PDF (pyHanko w services/osint-py, usługa lokalna) (`pdf_signing`) | internal_service | tak | 5 / 1 s | nie | F | https://github.com/MatthiasValvekens/pyHanko/blob/master/LICENSE | pyHanko (MIT) podpisuje PDF raportu (PAdES) lokalnym kluczem demonstracyjnym na tym komputerze; usługa nie otwiera połączeń sieciowych: żądanie znacznika czasu RFC 3161 wysyła strona Node (tylko skrót) przez źródło znakowania czasem. Certyfikat demonstracyjny jest samopodpisany i NIEkwalifikowany; kwalifikowany certyfikat na module HSM to kolejny krok produkcyjny. Dostęp wyłącznie przez klienta ruchu wychodzącego; nigdy nie jest odtwarzana z kaset ani do nich zapisywana. |
| Piaskownica: EVM (lokalny Anvil, API Otterscan) (`sandbox_anvil`) | chain_data | nie | 50 / 1 s | nie | A | brak opublikowanego regulaminu | Lokalny łańcuch EVM w profilu compose „sandbox” (chain id 1); tylko portfele demonstracyjne, bez sieci publicznej. Dozwolona na żywo w trybie offline; nie łączy się z hostem zewnętrznym. |
| Piaskownica: Bitcoin regtest (lokalny Esplora) (`sandbox_esplora`) | chain_data | nie | 20 / 1 s | nie | A | brak opublikowanego regulaminu | Lokalna sieć regtest w profilu compose „sandbox”; tylko portfele demonstracyjne, bez sieci publicznej. Dozwolona na żywo w trybie offline; nie łączy się z hostem zewnętrznym. |
| Wykaz podatników VAT (biała lista) (`vat_whitelist`) | registry | tak | 1 / 1 s | tak | A | https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat | Oficjalny interfejs pod adresem wykazpodatnikowvat.mf.gov.pl/api (dotychczasowy host wygasa 2026-12-01 i nie jest używany). Limit 100 wyszukiwań dziennie (w jednym przebiegu najwyżej 10); odpowiedź o przekroczeniu limitu zatrzymuje źródło. Osoby trzecie zapisujemy tylko jako imię, nazwisko i rolę, PESEL nigdy nie jest odczytywany. Warunki są zawarte w oficjalnej dokumentacji interfejsu. |
| Internet Archive – Wayback CDX / Availability (tylko odczyt) (`wayback_cdx`) | archive | tak | 20 / 60 s | tak | B | https://archive.org/about/terms.php | Wyłącznie odczyt, do 20 zapytań na minutę. NIGDY nie używamy Save Page Now na stronach podejrzanych, bo publikuje to zapis strony. |

### Źródła AMBER

Wyłączone domyślnie; analityk włącza je w sprawie z uzasadnieniem (co najmniej 20 znaków), które trafia do dziennika i raportu.

| Źródło | Rodzaj | Domyślnie włączone | Limit zapytań | Ujawnia identyfikator | Wiarygodność (Admiralty) | Regulamin | Uzasadnienie |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bitcointalk (strony dla gości) (`bitcointalk`) | forum | nie | 1 / 1 s | tak | B | https://bitcointalk.org/index.php?topic=5240891.0 | Forum toleruje uprzejme boty do 1 zapytania na sekundę, a naruszających blokuje. Tylko strony widoczne dla gościa, bez logowania. |
| BitList (ninjastic.space) – archiwum Bitcointalk (`bitlist`) | archive | nie | 1 / 2 s | tak | B | https://bitlist.co/terms | Interfejs bez klucza, bez opublikowanych limitów. Każde zapytanie ujawnia identyfikator prywatnemu operatorowi. Link prowadzi do strony z warunkami usługi; w produkcji lepsze są publiczne zrzuty danych. |
| Brave Search API (`brave_search`) | search | nie | 1 / 1 s | tak | C | https://brave.com/search/api/ | Płatne za zapytanie (5 USD za 1000, miesięczny kredyt 5 USD; od lutego 2026 bez darmowego planu); zapytanie z identyfikatorem trafia do Brave, a zerowe przechowywanie danych jest tylko w planie Enterprise. Przechowywanie wyników wymaga indywidualnego planu. Surowe odpowiedzi nie są zapisywane (tylko skrót); tytuły i fragmenty (zredagowane) zapisujemy tylko przy BRAVE_SEARCH_STORAGE_RIGHTS=true, w pozostałych przypadkach tylko pozycję i adres URL. Używane wyłącznie przy OLCYS_SEARCH_MODE=external w przebiegach live lub replay. |
| Etherscan API V2 (wiele sieci) (`etherscan_v2`) | chain_data | nie | 3 / 1 s | tak | A | https://etherscan.io/apiterms | Darmowy plan: 3 zapytania na sekundę, 100 tys. dziennie, licencja „tylko do użytku osobistego i badawczego”, wymagane wskazanie źródła; część sieci tylko w planach płatnych. Tylko prototyp; w produkcji Erigon + Otterscan. |
| Farcaster (węzeł Snapchain) (`farcaster`) | identity_protocol | nie | 2 / 1 s | tak | A | brak opublikowanego regulaminu | Weryfikacje są podpisane i publiczne, ale własność protokołu zmieniała się dwukrotnie w 2026 r., więc warunki wymagają ponownego sprawdzenia. Dla publicznego węzła nie opublikowano regulaminu; własny węzeł zachowuje prywatność zapytań. |
| GitHub REST API (`github`) | code_hosting | nie | 10 / 60 s | tak | B | https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies | Użycie interfejsu jest dozwolone, ale zasady dopuszczalnego użycia ograniczają przetwarzanie danych osobowych do celów, na które użytkownik wyraził zgodę. Wyszukiwanie w commitach wymaga tokenu (10 zapytań na minutę). |
| Maigret – wyszukiwanie nazwy użytkownika (services/osint-py) (`maigret`) | username_enumeration | nie | 4 / 1 s | tak | C | brak opublikowanego regulaminu | Łączy się z wieloma zewnętrznymi serwisami, podając im nazwę użytkownika. Przypięta baza, lista dozwolonych tagów (crypto, finance, pl, social, coding, messaging), bez proxy, bez obchodzenia CAPTCHA, bez --ai, bez sondy GraphQL X. To narzędzie lokalne – obowiązują regulaminy odpytywanych serwisów. |
| Mojeek Search API (`mojeek_search`) | search | nie | 1 / 1 s | tak | C | https://www.mojeek.com/services/search/web-search-api/ | Płatne za zapytanie (Startup 2 GBP, Business 3 GBP za 1000); umowa powierzenia bez podprocesorów, retencja 90 dni, zerowa na życzenie (zalecana w produkcji). Plan Startup pozwala buforować wyniki tylko przez godzinę. Surowe odpowiedzi nie są zapisywane (tylko skrót); w planie Startup (MOJEEK_PLAN, domyślny) zapisujemy tylko pozycję i adres URL, w Business i Enterprise także zredagowane tytuły i fragmenty. Używane wyłącznie przy OLCYS_SEARCH_MODE=external w przebiegach live lub replay. |
| Publiczny RPC Solany (`solana_public_rpc`) | chain_data | nie | 5 / 1 s | tak | A | https://solana.com/docs/rpc | 100 zapytań na 10 s na adres IP, nie do użytku produkcyjnego. Brak odrębnego regulaminu; zasady dla wspólnych publicznych punktów dostępu są w oficjalnej dokumentacji RPC. |
| Telegram – publiczny podgląd kanałów (t.me/s) (`telegram_preview`) | messenger_public | nie | 1 / 2 s | tak | C | https://telegram.org/tos | Wyłącznie podgląd publicznych kanałów, bez API i MTProto, bez grup. Dane pozyskane przez API Telegrama nie mogą służyć AI, więc treści z Telegrama nie trafiają do modelu językowego. Link prowadzi do ogólnych warunków usługi Telegrama. |
| TronGrid (TRON) (`trongrid`) | chain_data | nie | 5 / 1 s | tak | A | https://developers.tron.network/docs/trongrid | Własny, darmowy klucz; limity nieopublikowane (według zgłoszeń 10–100 tys. dziennie). W produkcji java-tron + indeksator TRC-20. Regulamin TronGrid akceptuje się przy rejestracji klucza API; link prowadzi do dokumentacji. |
| Wykop API v3 (`wykop`) | social | nie | 1 / 1 s | tak | C | https://doc.wykop.pl/ | Wymaga klucza i sekretu aplikacji (JWT); zasady wydawania kluczy i warunki nie są potwierdzone. Źródło za przełącznikiem funkcji. Link prowadzi do dokumentacji interfejsu. |

### Źródła RED

Nigdy nie są kontaktowane; wymuszone w kodzie (schemat rejestru, walidacja zakresu, lista dozwolonych hostów, kolektory).

| Źródło | Rodzaj | Domyślnie włączone | Limit zapytań | Ujawnia identyfikator | Wiarygodność (Admiralty) | Regulamin | Uzasadnienie |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Allegro / Allegro Lokalnie (`allegro`) | web | nie | brak (zablokowane) | tak | F | https://allegro.pl/regulamin | Regulamin zakazuje botów i narzędzi do wydobywania danych; API służy sprzedawcom do obsługi własnej sprzedaży. Blokowane hosty: allegro.pl, api.allegro.pl, allegrolokalnie.pl. |
| Discord (`discord`) | social | nie | brak (zablokowane) | tak | F | https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy | Polityka deweloperska zakazuje scrapingu i profilowania użytkowników. Blokowane hosty: discord.com, discordapp.com. |
| Gravatar API v3 (`gravatar`) | identity_protocol | nie | brak (zablokowane) | tak | B | https://gravatar.com/site/terms-of-service | Adresy portfeli (crypto_wallets) tylko z kluczem API; darmowy plan obejmuje „aktywnych użytkowników” klienta. Status RED, dopóki KAS nie ma planu płatnego lub wynegocjowanego. Blokowane hosty: gravatar.com, api.gravatar.com. |
| LinkedIn (`linkedin`) | social | nie | brak (zablokowane) | tak | F | https://www.linkedin.com/legal/user-agreement | Automatyczne zbieranie danych jest zabronione bez zgody właściciela. Blokowane hosty: linkedin.com, api.linkedin.com. |
| Linktree (`linktree`) | web | nie | brak (zablokowane) | tak | F | https://linktr.ee/s/terms | Regulamin zakazuje botów i scrapingu. Blokowane hosty: linktr.ee. |
| Facebook / Instagram (`meta`) | social | nie | brak (zablokowane) | tak | F | https://developers.facebook.com/terms/ | Automatyczne zbieranie danych jest zabronione bez zgody właściciela. Blokowane hosty: facebook.com, graph.facebook.com, instagram.com. |
| OLX (`olx`) | web | nie | brak (zablokowane) | tak | F | https://pomoc.olx.pl/olxplhelp/s/article/aktualny-regulamin-V32-olx | Regulamin zakazuje botów i scrapingu (aktualny zapis do ponownego sprawdzenia). Blokowane hosty: olx.pl. |
| Reddit (`reddit`) | social | nie | brak (zablokowane) | tak | F | https://www.redditinc.com/policies/data-api-terms | Brak nowych dostępów do API po 2026-10-31; nieuwierzytelniony JSON zamknięty; publiczne API wygasa w marcu 2027. Blokowane hosty: reddit.com, www.reddit.com, oauth.reddit.com. |
| X / Twitter (`x_twitter`) | social | nie | brak (zablokowane) | tak | F | https://x.com/en/tos | Umowa deweloperska zabrania śledzenia i prześwietlania użytkowników; scraping jest zakazany. Blokowane hosty: x.com, twitter.com, api.x.com, api.twitter.com. |
| YouTube (`youtube`) | social | nie | brak (zablokowane) | tak | F | https://developers.google.com/youtube/terms/developer-policies | Zasady zabraniają identyfikowania użytkowników bez ich zgody; 30-dniowy limit przechowywania koliduje z retencją materiału dowodowego. Blokowane hosty: youtube.com, www.youtube.com, youtube.googleapis.com. |

### Narzędzia niedozwolone

Narzędzia i pakiety, których projekt nie używa, wraz z powodem. Skan zależności w testach zgłasza każdą próbę ich dodania.

| Narzędzie | Kategoria | Powód | Pakiety |
| --- | --- | --- | --- |
| [h8mail](https://github.com/khast3x/h8mail) | Dane z wycieków | Narzędzie do przeszukiwania wycieków danych i haseł; dane z wycieków są poza dozwolonym zakresem OSINT. | pypi:h8mail |
| [GoSearch](https://github.com/ibnaleem/gosearch) | Dane z wycieków | Przeszukuje dane z infostealerów (wycieki); użycie takich danych jest zabronione. | — |
| [Mr.Holmes](https://github.com/Lucksi/Mr.Holmes) | Dane z wycieków | Wykorzystuje dane z wycieków; użycie takich danych jest zabronione. | — |
| [user-scanner (tryb --hudson)](https://github.com/kaifcodec/user-scanner) | Dane z wycieków | Tryb --hudson korzysta z danych z infostealerów; tryby e-mail odpytują punkty rejestracji i logowania. | pypi:user-scanner |
| [Moduły wycieków w SpiderFoot, theHarvester, IntelOwl i recon-ng](https://github.com/smicallef/spiderfoot) | Dane z wycieków | Te platformy zawierają moduły korzystające z baz wycieków; takie moduły pozostają wyłączone. | — |
| [holehe](https://github.com/megadose/holehe) | Sondowanie kont | Sprawdza konta e-mail przez funkcję odzyskiwania hasła (i rejestracji) w cudzych serwisach. | pypi:holehe |
| [Blackbird](https://github.com/p1ngul1n0/blackbird) | Sondowanie kont | Tryb e-mail odpytuje punkty rejestracji lub logowania w cudzych serwisach. | — |
| [socialscan (tryb e-mail)](https://github.com/iojw/socialscan) | Sondowanie kont | Tryb e-mail sprawdza dostępność adresu przez punkty rejestracji w cudzych serwisach. | pypi:socialscan |
| [GHunt](https://github.com/mxrch/GHunt) | Sesje i logowanie | Wymaga ciasteczek sesyjnych zalogowanego konta Google; nie logujemy się na konta w celu zbierania danych. | pypi:ghunt |
| [Osintgram](https://github.com/Datalux/Osintgram) | Sesje i logowanie | Narzędzie do analizy kont Instagrama; Instagram jest źródłem RED, a zakres narzędzia wykracza poza publiczny profil. | — |
| [toutatis](https://github.com/megadose/toutatis) | Sesje i logowanie | Narzędzie do pozyskiwania z Instagrama m.in. e-maili i numerów telefonów; Instagram jest źródłem RED. | pypi:toutatis |
| [SerpApi](https://serpapi.com/) | Scraping i omijanie zabezpieczeń | Odsprzedaje wyniki wyszukiwarek pozyskane scrapingiem, co rodzi problemy z ich regulaminami. | npm:serpapi, npm:google-search-results, pypi:serpapi, pypi:google-search-results |
| [Serper](https://serper.dev/) | Scraping i omijanie zabezpieczeń | Dostarcza wyniki Google pozyskane scrapingiem stron wyników. | — |
| [ddgs / duckduckgo-search](https://github.com/deedy5/ddgs) | Scraping i omijanie zabezpieczeń | Pobiera wyniki DuckDuckGo przez scraping, co jest sprzeczne z regulaminem serwisu. | npm:duckduckgo-search, pypi:ddgs, pypi:duckduckgo-search |
| [SearXNG (silniki scrapujące)](https://github.com/searxng/searxng) | Scraping i omijanie zabezpieczeń | Metawyszukiwarka odpytująca wyszukiwarki zewnętrzne automatycznie; jej silniki scrapujące nie są używane. | image:searxng/searxng |
| [Marple](https://github.com/soxoj/marple) | Scraping i omijanie zabezpieczeń | Scrapuje strony wyników wyszukiwarek, których regulaminy zwykle zabraniają zapytań automatycznych. | — |
| [crawl4ai](https://github.com/unclecode/crawl4ai) | Scraping i omijanie zabezpieczeń | Domyślnie ignoruje robots.txt i oferuje tryby ukrywania przed wykrywaniem botów. | pypi:crawl4ai |
| [archive.today](https://archive.today/) | Scraping i omijanie zabezpieczeń | Brak oficjalnego API, zabezpieczenia CAPTCHA, udokumentowane zmienianie zarchiwizowanej treści; nie nadaje się na źródło dowodowe. | — |
| [Save Page Now (na stronach podejrzanych)](https://web.archive.org/save) | Scraping i omijanie zabezpieczeń | Zapis publikuje przechwycenie strony i ujawnia zainteresowanie organu; używamy wyłącznie odczytu archiwum. | — |
| [eth-labels (jako źródło rozstrzygające)](https://github.com/dawsbot/eth-labels) | Scraping i omijanie zabezpieczeń | Dane pochodzą ze scrapingu Etherscan, mają ryzyko dotyczące pochodzenia i regulaminu oraz duże luki; nie rozstrzygają o atrybucji. | — |
| [Snoop](https://github.com/snooppr/snoop) | Niedozwolona licencja | Własnościowa licencja tylko do użytku osobistego; zabrania modyfikacji i użycia innego niż osobiste. | — |
| [Blockscout od wersji 11](https://github.com/blockscout/blockscout) | Niedozwolona licencja | Od wersji 11 licencja jest źródłowo dostępna, a nie otwarta; dopuszczalne są wyłącznie wersje otwarte (do 10.x). | image:blockscout/blockscout>=11 |
| [Dune Spellbook](https://github.com/duneanalytics/spellbook) | Niedozwolona licencja | Licencja BUSL-1.1 (źródłowo dostępna), nie otwarta. | — |
| [Memgraph](https://memgraph.com/) | Niedozwolona licencja | Licencja BSL 1.1: źródłowo dostępna, nie zatwierdzona przez OSI. | npm:memgraph, image:memgraph/memgraph |
| [Redis server od wersji 8](https://redis.io/) | Niedozwolona licencja | Od wersji 8 serwer nie jest już otwartym oprogramowaniem (RSALv2/SSPLv1/AGPLv3); zamiast niego Valkey. | image:redis>=8 |
| [QuestPDF](https://www.questpdf.com/) | Niedozwolona licencja | Licencja Community wyklucza podmioty sektora publicznego i nie jest zatwierdzona przez OSI. | — |
| [PdfSharp od wersji 6.5](https://github.com/empira/PDFsharp) | Niedozwolona licencja | Od wersji 6.5.0 licencja zmieniła się z MIT na AGPL-3.0-only. | — |
| [@neo4j-nvl/*](https://neo4j.com/docs/nvl/) | Niedozwolona licencja | Biblioteka bez standardowej licencji otwartej („SEE LICENSE IN LICENSE.txt”). | npm:@neo4j-nvl/* |
| [Dane OpenSanctions](https://www.opensanctions.org/licensing/) | Niedozwolona licencja | Dane na licencji niekomercyjnej (CC BY-NC), spoza listy dozwolonych licencji projektu. | — |
| [Dane Binance Vision](https://data.binance.vision/) | Niedozwolona licencja | Dane na licencji CC BY-NC-SA, czyli z klauzulą niekomercyjną. | — |
| [Modele PLLuM z licencją „nc”](https://pllum.org.pl/) | Niedozwolona licencja | Warianty „nc” mają licencję CC-BY-NC-4.0 (klauzula niekomercyjna). | — |
| [Turborepo (turbo)](https://turbo.build/) | Telemetria lub przepływ danych | Domyślnie zbiera anonimowe dane o użyciu i hoście (telemetria). | npm:turbo |
| [Next.js](https://nextjs.org/telemetry) | Telemetria lub przepływ danych | Domyślnie zbiera anonimową telemetrię. | npm:next |
| [Neo4j Community Edition](https://neo4j.com/) | Telemetria lub przepływ danych | Składnik GPL: dozwolony wyłącznie jako osobna, niezmodyfikowana usługa, nigdy jako zależność projektu. | image:neo4j |
| [WalletExplorer](https://www.walletexplorer.com/) | Telemetria lub przepływ danych | Zewnętrzny serwis; zapytania przekazywałyby adresy ze spraw podmiotowi spoza projektu (niezatwierdzony przepływ danych). | — |
| [Arkham API](https://www.arkm.com/) | Telemetria lub przepływ danych | Zewnętrzny, zastrzeżony serwis, którego warunki zakazują scrapingu; zapytania przekazywałyby adresy ze spraw podmiotowi spoza projektu. | — |
| [litellm](https://github.com/BerriAI/litellm) | Telemetria lub przepływ danych | Dwukrotnie skompromitowany w 2026 r. (PyPI, Docker) i domyślnie pobiera zdalną mapę kosztów modeli podczas importu. | npm:litellm, pypi:litellm |
| [Selenium Manager](https://www.selenium.dev/documentation/selenium_manager/) | Telemetria lub przepływ danych | Wysyła statystyki użycia do plausible.io, o ile nie włączono avoid-stats lub pracy offline. | — |
| [react-cytoscapejs](https://github.com/plotly/react-cytoscapejs) | Nieutrzymywane lub niebezpieczne | Nieaktualny wrapper (ostatnie wydanie 2022); używamy bezpośrednio API Cytoscape. | npm:react-cytoscapejs |
| [wallet-address-validator](https://github.com/ognus/wallet-address-validator) | Nieutrzymywane lub niebezpieczne | Porzucona biblioteka (ostatnie wydanie 2018). | npm:wallet-address-validator |
| [trezor-address-validator](https://www.npmjs.com/package/trezor-address-validator) | Nieutrzymywane lub niebezpieczne | Porzucona biblioteka (repozytorium zarchiwizowane). | npm:trezor-address-validator |
| [crypto-regex](https://www.npmjs.com/package/crypto-regex) | Nieutrzymywane lub niebezpieczne | Porzucona biblioteka (2017), same wyrażenia regularne bez walidacji sum kontrolnych. | npm:crypto-regex |
| [coinaddr](https://pypi.org/project/coinaddr/) | Nieutrzymywane lub niebezpieczne | Nie należy do zatwierdzonych bibliotek adresów; walidację zapewnia własny ekstraktor adresów. | pypi:coinaddr |
| [cryptoaddress](https://pypi.org/project/cryptoaddress/) | Nieutrzymywane lub niebezpieczne | Porzucona biblioteka (ostatnie wydanie 2019). | pypi:cryptoaddress |
| [monero (monero-python)](https://github.com/monero-ecosystem/monero-python) | Nieutrzymywane lub niebezpieczne | Porzucona biblioteka (repozytorium zarchiwizowane). | pypi:monero |
| [pyzbar](https://github.com/NaturalHistoryMuseum/pyzbar) | Nieutrzymywane lub niebezpieczne | Nieutrzymywane wiązanie Pythona (ostatnie wydanie 2022). | pypi:pyzbar |
| [jsQR](https://github.com/cozmo/jsQR) | Nieutrzymywane lub niebezpieczne | Nieaktualny dekoder (ostatnie wydanie 2021). | npm:jsqr |
| [js-lnurl](https://www.npmjs.com/package/js-lnurl) | Nieutrzymywane lub niebezpieczne | Nieaktualna biblioteka (2023) bez wskazanej licencji. | npm:js-lnurl |
| [social-analyzer](https://github.com/qeeqbox/social-analyzer) | Nieutrzymywane lub niebezpieczne | Licencja AGPL-3.0, a pakiet nieaktualizowany od 2022 r. | npm:social-analyzer, pypi:social-analyzer |
| [twint](https://github.com/twintproject/twint) | Nieutrzymywane lub niebezpieczne | Projekt zarchiwizowany (ostatnie wydanie 2019). | pypi:twint |
| [snscrape](https://github.com/JustAnotherArchivist/snscrape) | Nieutrzymywane lub niebezpieczne | Projekt nieutrzymywany (ostatni commit 2023). | pypi:snscrape |

#### Ograniczenia funkcji dozwolonych narzędzi

**Maigret**

- Bez proxy i rotacji adresów.
- Bez obchodzenia CAPTCHA i zabezpieczeń antybotowych.
- Bez opcji --ai.
- Baza serwisów przypięta do wersji, bez automatycznej aktualizacji.
- Bez sondy GraphQL serwisu X.

<!-- generated:sources:end -->
<!-- prettier-ignore-end -->

Przepływ danych: każde zapytanie do usługi zewnętrznej ujawnia odpytywany identyfikator i nasz adres IP. Dziennik
ruchu wychodzącego rejestruje każde takie ujawnienie (`containsIdentifier`), a wdrożenia produkcyjne powinny
preferować własne węzły, lokalne kopie zbiorów danych i dostawców z umową powierzenia przetwarzania (DPA).

Szczegółowe uzasadnienie statusu każdego źródła (pola `complianceNote`, `complianceNotePl`, `tosUrl`) jest w `config/sources.yaml`
i w tabelach powyżej. Wpis wymaga polskiej nazwy i uwagi oraz klucza `tosUrl` (`null` = brak opublikowanego regulaminu); źródła RED
muszą wymieniać blokowane hosty — nie są kontaktowane nawet jako „dodatkowe” hosty wdrożenia.

## Wyszukiwarki internetowe

- **Demonstracja i testy:** wyłącznie wyszukiwarka testowa (`mock_search`, GREEN, `OLCYS_SEARCH_MODE=mock` — domyślnie).
  Przeszukuje strony z mapy witryny strony testowej (z poszanowaniem robots.txt) i dopasowuje zapytania lokalnie, więc
  żaden identyfikator nie opuszcza komputera.
- **Brave Search API i Mojeek** (AMBER, płatne za zapytanie): tylko w trybie `OLCYS_SEARCH_MODE=external`, w przebiegach
  `live` lub `replay`, z kluczem ze zmiennej środowiskowej i po włączeniu źródła w sprawie z uzasadnieniem. Każde
  zapytanie ujawnia dostawcy identyfikator i jest odnotowane w dzienniku ruchu (`containsIdentifier: true`). Do produkcji
  zalecany Mojeek z umową DPA (bez podprzetwarzających) i zerową retencją danych na żądanie; Brave oferuje zerową
  retencję tylko w planie Enterprise.
- **Przechowywanie wyników zgodnie z warunkami dostawców:** surowa odpowiedź wyszukiwarki nigdy nie jest zapisywana ani
  nagrywana (tylko jej skrót SHA-256 i rozmiar) — fragmenty wyników to tekst ze stron, który może zawierać sekrety.
  Tytuły i fragmenty wyników (po redakcji sekretów) zostają w przechwyceniu tylko z prawem do przechowywania: Brave — w
  planie niestandardowym (`BRAVE_SEARCH_STORAGE_RIGHTS=true`), Mojeek — w planach Business i Enterprise (`MOJEEK_PLAN`;
  Startup pozwala buforować wyniki najwyżej godzinę). W pozostałych przypadkach w przechwyceniu zostają tylko pozycje i
  adresy wyników. Czy taka lista adresów jako ślad audytowy mieści się w warunkach dostawców, wymaga potwierdzenia
  prawnego przed wdrożeniem.
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

## Rejestry publiczne (CEIDG, wykaz podatników VAT, KRS)

- **Charakter:** oficjalne API państwowe (GREEN, wiarygodność A). Dają powiązanie imię i nazwisko → firma → rachunek
  bankowy; fakty rejestrowe nie mają poziomu adresowego i nie zmieniają Wskaźnika Pewności adresów.
- **CEIDG API v3:** jedyne oficjalne API wyszukujące po imieniu i nazwisku. Wymaga własnego tokenu instytucji
  (`CEIDG_API_TOKEN`, tylko zmienna środowiskowa, nagłówek `Authorization`, nigdy w dzienniku ani w nagraniach); bez tokenu
  worker w trybie `live` nie rejestruje źródła. Limit w rejestrze źródeł: 1 żądanie / 4 s (publikowane: 50 / 3 min, 1000 / h);
  błędów limitu nie ponawiamy. Imię i nazwisko mogą mieć imienników, więc numer NIP jest przekazywany dalej tylko przy
  dokładnie jednym trafieniu — w przeciwnym razie zadanie jest pomijane jako `ambiguous_namesake`.
- **Wykaz podatników VAT:** bez klucza, host `wykazpodatnikowvat.mf.gov.pl` (poprzedni host API zostanie wyłączony 2026-12-01
  i nie jest używany). Limit 100 wyszukań dziennie; przebieg wykonuje najwyżej 10, odpowiedź o limicie zatrzymuje źródło.
  Identyfikator sprawdzenia (`requestId`) jest zapisywany jako urzędowy dowód.
- **KRS Open API:** bez klucza (dane otwarte), wyłącznie po numerze KRS. Okna serwisowe objawiają się stroną „Przerwa
  techniczna” — to błąd źródła, a nie brak wpisu.
- **Minimalizacja danych (RODO):** numery PESEL nie są czytane ani zapisywane jako obserwacje; osoby trzecie (reprezentanci,
  prokurenci, wspólnicy, zarząd) trafiają do raportu jako nazwa i rola i nigdy nie stają się podstawą dalszego
  wyszukiwania. Zapytania ujawniają rejestrom imię, nazwisko lub numer podatkowy badanej osoby i są odnotowane w dzienniku
  ruchu (`containsIdentifier: true`). Dane testowe są syntetyczne (NIP, REGON, KRS i rachunki celowo nieprzydzielone).

## Archiwum internetowe (Wayback Machine)

- **Charakter:** `wayback_cdx` (GREEN, wiarygodność B) — wyłącznie odczyt: Availability API, CDX z `collapse=digest` i
  odtwarzanie surowej migawki (`id_`). Do 20 zapytań na minutę, jedno naraz; odpowiedź 429, która utrzymuje się po
  odczekaniu klienta, wstrzymuje źródło do końca przebiegu (archiwum blokuje klientów, którzy nadal wysyłają po 429).
- **robots.txt:** przy pobieraniu migawek respektujemy robots.txt hosta archiwum (zakaz = `blocked`, `robots_disallowed`);
  robots.txt witryny źródłowej nie jest sprawdzany dla jej kopii w archiwum. Zapytania do API (Availability, CDX) go nie dotyczą.
- **Save Page Now jest zakazane.** Zapisałoby stronę podejrzaną w publicznym archiwum i ujawniło zainteresowanie
  śledczych. Kod nie ma ścieżki, która zbudowałaby adres punktu zapisu (`assertWaybackReadUrl`, test w
  `packages/collectors/test/wayback.test.ts`); używane jest tylko `GET`. archive.today jest wykluczone (zmieniane
  archiwa, ściana CAPTCHA).
- **Czego dotyczy zapytanie:** wyłącznie adresów profili kont samej badanej osoby (podanych przez analityka albo
  wskazanych przez jej własne strony) i dopasowanych stron z listy obserwowanych — nie stron osób trzecich. Adres jest
  ujawniany Internet Archive, więc każde zapytanie ma w dzienniku ruchu `containsIdentifier: true`.
- **Dowód:** migawka jest kopią z archiwum (pole `archive` przechwycenia), a nie stanem strony w chwili zbierania; ma tę
  samą grupę pochodzenia co strona, którą odwzorowuje, więc nie zwiększa Wskaźnika Pewności — dodaje historię. Zgodność
  skrótu migawki ze skrótem z CDX jest zapisywana jako obliczenie.
- **Otwarte pytanie prawne:** warunki korzystania z Internet Archive udzielają dostępu „dla celów naukowych i
  badawczych”. Czy obejmują one użycie przez organ administracji (KAS) w czynnościach urzędowych, wymaga opinii
  prawnej, zanim źródło zostanie włączone w sprawie prowadzonej na żywo.
