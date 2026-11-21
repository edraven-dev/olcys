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

| Adres                                   | Zawartość                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                     | lista spraw                                                                                                                                                                                                                                                                                                           |
| `/sprawy/nowa`                          | nowa sprawa: cel i podstawa prawna (wymagane), identyfikatory (imię i nazwisko, nick, identyfikator z komunikatora, login, e-mail, adres kryptowalutowy), źródła z rejestru zgodności (GREEN domyślnie, AMBER z uzasadnieniem ≥ 20 znaków, RED zablokowane), sieci, głębokość rozwijania, potwierdzenie minimalizacji |
| `/sprawy/:id`                           | sprawa: cel, identyfikatory, zablokowany zakres, uruchamianie analizy, historia przebiegów z liczbą zmian i alertów                                                                                                                                                                                                   |
| `/sprawy/:id/przebiegi/:runId/przeglad` | postęp na żywo (odpytywanie `/api/runs/:id` co sekundę), etapy, liczniki, wynik końcowy, źródła (niedostępne oddzielnie od „nie znaleziono”), parametry odtwarzalności                                                                                                                                                |
| `…/powiazania`                          | powiązane adresy: Wskaźnik Pewności 0–100, przedział (BARDZO WYSOKIE / PRAWDOPODOBNE / ŚREDNIE / NISKIE / WYKLUCZENIE), termin ICD 203, synergia śladów, rozwijane uzasadnienie z wykresem wodospadowym (SVG) i tabelą, bramki, dowody źródłowe                                                                       |
| `…/odrzucone`                           | odrzucone adresy: reguły A1–A8 (giełda, adres depozytowy, smart kontrakt, lista wykluczeń) z etykietami i ich pochodzeniem, przypisania przez stronę trzecią, słaba tożsamość, dopasowania odrzucone przy weryfikacji (homoglify z wyróżnieniem znaków spoza ASCII)                                                   |
| `…/aktywnosc`                           | aktywność on-chain wybranego adresu: wolumeny w walucie i PLN, kontrahenci, przesłanki wyjścia do fiat (B1–B7) z kursem NBP, interakcje z usługami, wymiany, transfery                                                                                                                                                |
| `…/zrodla`                              | zabezpieczenia stron (URL, czas, SHA-256, status, pliki do pobrania), fakty odczytane ze źródeł, znalezione konta, dziennik połączeń wychodzących z filtrami                                                                                                                                                          |
| `…/zmiany`                              | zmiany względem poprzedniej analizy; podmiana adresu portfela jako alert z wartościami „było/jest” i oboma zabezpieczeniami                                                                                                                                                                                           |
| `…/raport`                              | odnośnik do raportu HTML (`/api/runs/:id/report`)                                                                                                                                                                                                                                                                     |

## Zasady

- **Tylko własne API.** Konsola łączy się wyłącznie z `/api` (w trybie deweloperskim przez proxy Vite). Brak CDN,
  zdalnych czcionek, analityki i telemetrii; adresy URL źródeł są pokazywane jako tekst do skopiowania, nie jako
  odnośniki. Test `test/ui-rules.test.ts` pilnuje braku adresów zewnętrznych w kodzie.
- **Dowody tylko do pobrania.** Pliki z zabezpieczeń (`/api/blobs/<sha256>`) są pobierane jako załączniki — konsola
  ich nie osadza ani nie wyświetla.
- **Fakty, obliczenia, wnioski.** Każdy blok ma etykietę tekstową „Fakt źródłowy”, „Wynik obliczeń” albo „Wniosek do
  weryfikacji” i własny styl krawędzi — kolor nie jest jedynym nośnikiem znaczenia.
- **Teksty po polsku w jednym miejscu.** Wszystkie napisy są w `src/i18n/pl.ts` (`t()` i `plural()` z
  `src/i18n/t.ts`, polska odmiana liczebników). Test sprawdza, że komponenty nie zawierają literałów tekstowych.
- **Kwoty i daty.** Kwoty `DecimalString` są formatowane dokładnie (bez liczb zmiennoprzecinkowych), daty w strefie
  Europe/Warsaw z czasem UTC w podpowiedzi.
- **Dane częściowe.** Brakujące pola opcjonalne nie psują widoku: przedział wyniku jest wyliczany z wartości, gdy
  silnik go nie podał; synergia śladów jest wyprowadzana ze ścieżek; brak tras `/api/runs/:id/extractions` lub
  `/api/labels` oznacza pustą sekcję.
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

Vitest (środowisko Node, bez dodatkowych zależności): formatowanie kwot i dat `pl-PL`, przedziały wyniku, parsowanie
odpowiedzi API, modele widoków (wykres wodospadowy, synergia, odrzucenia, zmiany, aktywność, formularz), zgodność
katalogu z rdzeniem i konfiguracją wag oraz proste renderowanie komponentów (`react-dom/server`).
