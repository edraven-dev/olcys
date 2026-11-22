# @olcys/web — konsola analityka

Interfejs React (Vite) w języku polskim dla analityków KAS. Prowadzi przez obowiązkowy scenariusz: dane wejściowe →
wyszukanie śladów OSINT → wykrycie i weryfikacja adresów → Wskaźnik Pewności → odrzucenie błędnych przypisań →
wskaźniki aktywności on-chain i wyjścia do walut tradycyjnych → źródła i wynik końcowy, a po ponownej analizie —
zmiany z alertem podmiany portfela.

## Uruchamianie

```bash
pnpm dev                            # API :4000, konsola :5173 (Vite przekazuje /api do API)
pnpm --filter @olcys/web dev        # tylko konsola
pnpm --filter @olcys/web build      # wersja produkcyjna w apps/web/dist
pnpm vitest run --project @olcys/web
```

## Ekrany i adresy

| Adres                                   | Zawartość                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                     | lista spraw                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/sprawy/nowa`                          | nowa sprawa: cel i podstawa prawna (wymagane), identyfikatory (imię i nazwisko, nick, identyfikator z komunikatora, login, e-mail, adres kryptowalutowy), źródła z rejestru zgodności (GREEN domyślnie, AMBER z uzasadnieniem ≥ 20 znaków; RED nie są opcją wyboru, formularz podaje ich liczbę i odsyła do rejestru), sieci, głębokość rozwijania, potwierdzenie minimalizacji                                                               |
| `/sprawy/:id`                           | sprawa: cel, identyfikatory, zablokowany zakres, uruchamianie analizy, historia przebiegów z liczbą zmian i alertów, harmonogram analiz okresowych (cron w UTC, najbliższe terminy, ostatnie wyzwolenia, zmiana z powodem)                                                                                                                                                                                                                    |
| `/sprawy/:id/przebiegi/:runId/przeglad` | postęp na żywo (odpytywanie `/api/runs/:id` co sekundę), etapy, liczniki, wynik końcowy, źródła (niedostępne oddzielnie od „nie znaleziono”), parametry odtwarzalności                                                                                                                                                                                                                                                                        |
| `…/powiazania`                          | powiązane adresy: Wskaźnik Pewności 0–100, przedział (BARDZO WYSOKIE / PRAWDOPODOBNE / ŚREDNIE / NISKIE / WYKLUCZENIE), termin ICD 203, synergia śladów, rozwijane uzasadnienie z wykresem wodospadowym (SVG) i tabelą, bramki, dowody źródłowe                                                                                                                                                                                               |
| `…/graf`                                | graf powiązań (Cytoscape.js): osoba badana → identyfikatory → konta → adresy → podmioty; grubość krawędzi to prawdopodobieństwo etapu, odrzucone adresy i przypisania stron trzecich wyglądają inaczej niż własność; opcjonalnie przepływy środków; widok listy jako dostępny odpowiednik                                                                                                                                                     |
| `…/odrzucone`                           | odrzucone adresy: reguły A1–A8 (giełda, adres depozytowy, smart kontrakt, lista wykluczeń) z etykietami i ich pochodzeniem, przypisania przez stronę trzecią, słaba tożsamość, dopasowania odrzucone przy weryfikacji (homoglify z wyróżnieniem znaków spoza ASCII)                                                                                                                                                                           |
| `…/aktywnosc`                           | aktywność on-chain wybranego adresu: wolumeny w walucie i PLN, kontrahenci, przesłanki wyjścia do fiat (B1–B7) z kursem NBP, interakcje z usługami, wymiany, transfery                                                                                                                                                                                                                                                                        |
| `…/zrodla`                              | zabezpieczenia stron (URL, czas, SHA-256, status, pliki do pobrania), fakty odczytane ze źródeł, znalezione konta, dziennik połączeń wychodzących z filtrami                                                                                                                                                                                                                                                                                  |
| `…/zmiany`                              | zmiany względem poprzedniej analizy; podmiana adresu portfela jako alert z wartościami „było/jest” i oboma zabezpieczeniami                                                                                                                                                                                                                                                                                                                   |
| `…/zmiany`                              | (jw.) oraz panel „Oś czasu strony”: osie czasu portfeli (`GET /api/cases/:id/timeline?walletOnly=true`) — okresy z plakietką „kopia archiwalna” lub „przebieg”, zmiany z przedziałem czasu, daty przybliżone („ten sam skrót”) i luki                                                                                                                                                                                                         |
| `…/raport`                              | raport wyrenderowany w React z modelu raportu (`/api/runs/:id/report/view`): blok odtwarzalności, podsumowanie z osobnym zdaniem o pewności analitycznej, rozdzielone sekcje „A. Fakty źródłowe”, „B. Wyniki obliczeń”, „C. Wnioski wymagające weryfikacji”, chronologia przepływu środków, zmiany od poprzedniej analizy i rejestr dowodów; pliki do pobrania (HTML, manifest JSON, znaczniki RFC 3161, STIX, MISP, CSV) ze skrótami SHA-256 |
| `/ustawienia`                           | tylko do odczytu: tryb pracy, wersje (narzędzie, kontrakty, ekstraktor, reguły), wymienny model zgodny z OpenAI (tylko host, model, stan — nigdy klucz), status wag, rejestr źródeł, zmienne wyłączające telemetrię                                                                                                                                                                                                                           |

## Graf powiązań

Zakładka „Graf powiązań” (`…/graf`) pokazuje te same wyniki co tabela powiązań w postaci grafu; nie dodaje ustaleń
i nie korzysta z nowych tras API (`links`, `exclusions`, `accounts`, a przy włączonych przepływach także `activity`).

- **Budowa grafu.** Czysta funkcja `buildGraph` (`src/features/graph/build-elements.ts`) tworzy węzły (osoba badana,
  identyfikatory, konta, adresy, podmioty) i krawędzie: identyfikator wejściowy, etap tożsamości („P = …”, „kotwica”
  dla założenia analityka), etap adresu („P = … · poziom dowodu”), adres opublikowany przez konto, ale odrzucony jako
  majątek (np. trop KYC), przypisanie przez stronę trzecią, odrzucenie regułą A1–A8 i przepływ środków (suma w PLN,
  gdy każda interakcja ma wycenę — przy wycenie częściowej etykieta pokazuje sumę z dopiskiem „wycena niepełna: x z y”; kwoty sumowane dokładnie, bez liczb zmiennoprzecinkowych). Grubość krawędzi etapu
  to 1 + 5·P. Odrzucone adresy i strony trzecie nigdy nie są krawędziami własności.
- **Rysowanie.** `CytoscapeGraph` używa biblioteki Cytoscape.js bezpośrednio (bez nakładki React): instancja jest
  tworzona w efekcie i niszczona przy odmontowaniu (bezpieczne w React StrictMode). Układy wbudowane, bez dodatkowych
  zasobów i bez animacji: warstwowy (domyślny, `breadthfirst`) i siłowy (`cose`). Motyw jasny i ciemny według
  `prefers-color-scheme`; znaczenie nie zależy wyłącznie od koloru (kształt węzła, styl linii i etykiety tekstowe).
- **Sterowanie.** „Pokaż odrzucone”, „Minimalny Wskaźnik Pewności” (filtr dotyczy powiązań z wynikiem; odrzucone nie mają
  wyniku i zostają), „Pokaż przepływy środków”, wybór układu, „Dopasuj do ekranu”.
- **Panel szczegółów.** Wybór węzła lub krawędzi pokazuje szczegóły oraz odnośniki: „Pokaż dowody” (otwiera
  uzasadnienie powiązania w zakładce „Powiązane adresy”, a dla odrzuconych adresów i powiązań bez roszczenia własności —
  ich kartę w zakładce „Odrzucone adresy”) i „Pokaż aktywność on-chain” (zakładka aktywności z
  wybranym adresem).
- **Dostępność.** Pojemnik grafu ma `role="img"` i opis z poprawnymi formami liczebników („14 węzłów i 15 krawędzi”,
  „2 węzły”). „Pokaż jako listę” zastępuje graf tabelami węzłów i krawędzi z tymi samymi etykietami, w pełni
  obsługiwanymi klawiaturą.
- **Limit elementów.** Powyżej 500 elementów (węzły i krawędzie) graf jest obcinany w kolejności ważności: osoba
  badana, identyfikatory, konta i adresy powiązań z tabeli głównej, odrzucone i strony trzecie, na końcu przepływy;
  w obrębie poziomu zachowywane są całe ścieżki (identyfikator → konto → adres), więc obcięty graf nie zawiera
  adresów odciętych od osoby badanej; baner podaje łączną liczbę elementów.
- **Dane nie opuszczają przeglądarki.** Brak eksportu grafu; brak zdalnych zasobów.

## Zasady

- **Tylko własne API.** Konsola łączy się wyłącznie z `/api` (w trybie deweloperskim przez proxy Vite). Brak CDN,
  zdalnych czcionek, analityki i telemetrii; adresy URL źródeł są pokazywane jako tekst do skopiowania, nie jako
  odnośniki. Test `test/ui-rules.test.ts` pilnuje braku adresów zewnętrznych w kodzie.
- **Dowody tylko do pobrania.** Pliki z zabezpieczeń (`/api/blobs/<sha256>`) są pobierane jako załączniki — konsola
  ich nie osadza ani nie wyświetla.
- **Fakty, obliczenia, wnioski.** Każdy blok ma etykietę tekstową „Fakt źródłowy”, „Wynik obliczeń” albo „Wniosek do
  weryfikacji” i własny styl krawędzi — kolor nie jest jedynym nośnikiem znaczenia.
- **Ocena i korekty analityka.** Gdy `GET /api/meta` zwraca `features.judgements`, karta powiązania ma formularz oceny
  (potwierdzone / odrzucone / niepewne, uzasadnienie ≥ 10 znaków) i listę ocen z analitykiem i czasem — z informacją, że
  ocena nie zmienia obliczonego Wskaźnika Pewności; rozwijane uzasadnienie ma formularz korekty (ocena wiarygodności
  obserwacji, wykrytego adresu lub źródła, decyzja o dopasowaniu wymagającym przeglądu, przesłanka z zamkniętej listy),
  a nad listą powiązań są korekty sprawy ze stanem („uwzględniona w tym przebiegu” / „oczekuje na ponowną ocenę”)
  i przycisk ponownej oceny (rescore). Zakładka „Raport” pozwala wygenerować nową wersję raportu z zapisanymi ocenami.
- **Teksty po polsku w jednym miejscu.** Wszystkie napisy są w `src/i18n/pl.ts` (`t()` i `plural()` z
  `src/i18n/t.ts`, polska odmiana liczebników). Test sprawdza, że komponenty nie zawierają literałów tekstowych.
- **Kwoty i daty.** Kwoty `DecimalString` są formatowane dokładnie (bez liczb zmiennoprzecinkowych), daty w strefie
  Europe/Warsaw z czasem UTC w podpowiedzi.
- **Dane częściowe.** Brakujące pola opcjonalne nie psują widoku: przedział wyniku jest wyliczany z wartości, gdy
  silnik go nie podał; synergia śladów jest wyprowadzana ze ścieżek; brak tras `/api/runs/:id/extractions` lub
  `/api/labels` oznacza pustą sekcję.
- **Błędy odczytu są widoczne.** Nieudane odświeżenie zostawia poprzednie dane z ostrzeżeniem (czas danych i
  „Spróbuj ponownie”); sekcja bez danych z powodu błędu jest oznaczona jako niedostępna — nigdy jako pusty wynik.
- **Wzmianki bez domysłów.** Przy odrzuconym adresie konsola pokazuje, gdzie i przez kogo adres był wspomniany
  (wzmianki stron trzecich są oznaczone); trop KYC pojawia się tylko wtedy, gdy silnik analizy ustalił, że adres
  opublikowała sama osoba (`evidence.kycLead`).
- **Typ adresu przy decyzji.** Karta reguły w zakładce „Odrzucone adresy” pokazuje typ adresu z analizy łańcuchowej
  (`/api/runs/:id/address-types`: konto zewnętrzne (EOA), EOA z delegacją EIP-7702, konto Safe, konto inteligentne
  ERC-4337, kontrakt tokena, kontrakt, skrypt UTXO, nieznany typ) z delegatem, kontraktem bazowym Safe, EntryPoint lub
  implementacją proxy; typ pochodzi z sieci zapisanej w decyzji (`resolved`, dla kandydata bez wskazanej sieci EVM)
  albo z klasyfikacji, której zapytania decyzja cytuje — nigdy z kolejności listy. Brak trasy oznacza kartę bez typu.
- **Dostępność.** Nawigacja klawiaturą, etykiety wszystkich pól, odnośnik „Przejdź do treści”, komunikaty o postępie
  w regionie `aria-live`, tabele z nagłówkami, układ działający na szerokości telefonu, motyw jasny i ciemny.
- **Tylko typy z `@olcys/core`.** Do przeglądarki nie trafia kod serwera; lokalne listy (sieci, etapy) są
  porównywane z rdzeniem w testach.

## Komponenty wspólne

`src/components/ui.tsx`: ikony, `KindBadge`/`KindBlock` (rodzaj informacji), `RunStatusBadge`,
`CaptureStatusBadge`, `ComplianceBadge`, `BandBadge`, `ScoreMeter`, `AddressText`, `HashText`, `CopyButton`,
`DateTime`, `Verbatim`, stany `LoadingState`/`EmptyState`/`ErrorState` i `Async`.
`src/components/evidence.tsx`: `CaptureCard`, `CaptureFiles`, `ObservationLine`, `CandidateSnippet`.

## Testy

Vitest (środowisko Node; testy komponentów montowanych w DOM używają happy-dom przez nagłówek `@vitest-environment`): formatowanie kwot i dat `pl-PL`, przedziały wyniku, parsowanie
odpowiedzi API, modele widoków (wykres wodospadowy, synergia, odrzucenia, zmiany, aktywność, formularz), zgodność
katalogu z rdzeniem i konfiguracją wag oraz proste renderowanie komponentów (`react-dom/server`).

## Raport i pliki do pobrania

Zakładka „Raport” nie osadza wygenerowanego HTML: pobiera model raportu z `GET /api/runs/:id/report/view` (te same dane,
z których powstaje HTML) i renderuje go natywnie. Pozycje trzech rodzajów stwierdzeń nigdy się nie mieszają; „Pokaż
zabezpieczenie” wczytuje kartę zabezpieczenia dopiero na żądanie. Tekst ze źródeł jest pokazywany wyłącznie jako tekst.

Tabela „Pliki do pobrania” pokazuje rozmiar i pełny skrót SHA-256 każdego pliku. Nie ma logowania ani kont, a pobranie
niczego nie wymaga. Opcjonalne pole „Cel pobrania” jest wysyłane jako nagłówek `X-Olcys-Purpose` (wartość zakodowana
`encodeURIComponent`, bo nagłówki HTTP nie przenoszą polskich znaków); dziennik dostępu odczytuje go i dekoduje.
Pobieranie to `fetch` do własnego API, adres `blob:` i zwykły odnośnik `download` — bez skryptów w treści strony.
