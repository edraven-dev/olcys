# @olcys/reporting

Raport z analizy OSINT o jakości dowodowej: samodzielny dokument HTML w języku polskim, zbudowany z zapisanych danych
przebiegu, z wyraźnym rozdzieleniem faktów źródłowych, wyników obliczeń i wniosków wymagających weryfikacji; oraz krok
potoku `report.render`, który raport generuje i zapisuje.

- **Zależności:** wyłącznie kontrakty `@olcys/core` (testy używają też `@olcys/db` i `@olcys/evidence`).
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/reporting`.

## Zawartość raportu

1. Metryka raportu i parametry odtwarzalności — sprawa, cel i podstawa prawna, identyfikatory wejściowe, źródła
   włączone dla sprawy, identyfikator i tryb przebiegu, wersje narzędzia, algorytmu, wag i reguł ze skrótami SHA-256,
   model AI („nieużywany”, gdy go nie było), skrót SHA-256 danych wejściowych raportu.
2. Podsumowanie ustaleń dla osób bez wiedzy informatycznej.
3. Adresy powiązane z identyfikatorami — Wskaźnik Pewności 0–100, przedział z treści zadania (80–100 BARDZO WYSOKIE,
   60–79 PRAWDOPODOBNE, 40–59 ŚREDNIE, 10–39 NISKIE / SZUM, 0 WYKLUCZENIE), określenie ICD 203, osobno pewność
   analityczna, ścieżki i przesłanki z wkładem w wynik oraz synergia śladów (ten sam adres w niezależnych źródłach).
4. Odrzucone przypisania — reguły A1–A8 z wynikiem i dowodami (adres depozytowy giełdy, usługa oznaczona etykietą, smart
   kontrakt, lista wykluczeń), przypisania przez stronę trzecią oraz zapisy odrzucone przy weryfikacji adresu (przykład
   z dokumentacji, homoglify). Interakcje z giełdami są odnotowywane, a nie przypisywane osobie.
5. Aktywność on-chain i przesłanki wyjścia do walut tradycyjnych — wartości w PLN z tabelą, datą i kursem NBP.
6. Chronologia przepływu środków — zdania w kolejności czasu, zbudowane z transakcji, krawędzi przepływu i zdarzeń
   wyjścia do walut tradycyjnych.
7. Zmiany od poprzedniego uruchomienia — alert podmiany adresu portfela z oboma zabezpieczeniami.
8. Rejestr materiału dowodowego — każda strona z adresem URL, czasem pobrania, statusem i skrótami SHA-256 oraz
   podsumowanie dziennika połączeń wychodzących.
9. Metodyka i ograniczenia.

Każda treść należy do jednej z trzech klas, renderowanych w osobnych, opisanych blokach (`data-statement="fakty"`,
`"obliczenia"`, `"wnioski"`) z różnym obramowaniem (ciągłe, podwójne, przerywane — czytelne także w druku czarno-białym).

## Bezpieczeństwo i jakość dokumentu

- Każda wartość wstawiana do HTML jest escapowana (`html`, `t()`); znaki niewidoczne i sterujące kierunkiem tekstu są
  pokazywane jako kody (`⟦U+202E⟧`). Treści ze stron są danymi, nigdy znacznikami.
- Dokument jest samowystarczalny: jeden wbudowany `<style>`, lokalne kroje pisma, nagłówek CSP
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:`, brak skryptów, arkuszy, ramek i zdalnych obrazów.
  Adresy URL są tekstem, nie odnośnikami. `assertSelfContainedHtml()` sprawdza to przed zapisem.
- Kwoty (`DecimalString`) są formatowane operacjami na tekście (przecinek dziesiętny, grupy cyfr od 5 cyfr z twardą
  spacją, zaokrąglenie dziesiętne z `@olcys/core`) — bez liczb zmiennoprzecinkowych. Czas jest w UTC.
- Wynik jest deterministyczny: te same dane dają identyczny dokument. Dane wejściowe zapisywane są obok raportu jako
  JSON (RFC 8785); ich skrót SHA-256 jest podany w metryce raportu.

## Publiczne API

- `renderReport(data: ReportData): string` — czysta funkcja zwracająca dokument HTML.
- `buildReportData(repos, runId, options?)` — składa `ReportData` z portów repozytoriów (`options`: `sources` z rejestru
  źródeł, `weightsStatus`, `generatedAt`, `reportId`). Brakujące pola opcjonalne innych pakietów są tolerowane.
- `createReportStage(options?)` — krok `report.render`: składa dane, renderuje, sprawdza HTML, zapisuje w magazynie
  treści i rejestruje raporty `html` (`text/html; charset=utf-8`) i `data_json` (`application/json`) przez
  `repos.analysis.addReport()`.
- `storeReport(deps, data)`, `assertSelfContainedHtml(html)`, `ExternalReferenceError`, `reportDataJson(data)`,
  `scoreBand(score, excluded?)`, `icdTerm(link)`, formatery (`formatPln`, `formatAmount`, `formatUtc`, …) oraz katalog
  tekstów `pl`.

## Włączenie kroku w potoku

```ts
// apps/api/src/stages.ts
import { createReportStage } from '@olcys/reporting';

export function defaultStages(runtime) {
  return [
    // … zbieranie, wyodrębnianie adresów, analiza łańcucha, punktacja …
    createReportStage({ sources: runtime.sources, weightsStatus: 'uncalibrated' }),
  ];
}
```

Potok wykonuje porównanie z poprzednim przebiegiem jako wbudowany krok `diff.previous`; krok `report.render` działa po
nim, więc raport zawiera wykryte zmiany. `GET /api/runs/:id/report` zwraca najnowszy raport `html` przebiegu.
