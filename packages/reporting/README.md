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
2. Podsumowanie ustaleń dla osób bez wiedzy informatycznej. Gdy część źródeł była niedostępna (blokada, logowanie,
   CAPTCHA, błąd pobierania) albo etap zgłosił braki (`progress.partial`), na początku podsumowania i w metryce widnieje
   ostrzeżenie „Analiza niepełna”.
3. Adresy powiązane z identyfikatorami — Wskaźnik Pewności 0–100, przedział z treści zadania (80–100 BARDZO WYSOKIE,
   60–79 PRAWDOPODOBNE, 40–59 ŚREDNIE, 10–39 NISKIE / SZUM, 0 WYKLUCZENIE), określenie ICD 203, osobno pewność
   analityczna, ścieżki i przesłanki z wkładem w wynik oraz synergia śladów. Przedział i synergię (niezależne serwisy,
   premia, pominięte powtórzenia) podaje algorytm oceny; bez jego oceny raport tylko liczy wystąpienia adresu.
4. Odrzucone przypisania — reguły A1–A8 z wynikiem `excluded` lub `reclassified` i dowodami (adres depozytowy giełdy,
   usługa oznaczona etykietą, smart kontrakt, lista wykluczeń), przypisania przez stronę trzecią oraz zapisy odrzucone
   przy weryfikacji adresu (przykład z dokumentacji, homoglify). Wynik `flagged` jest ostrzeżeniem, a nie odrzuceniem.
   Przy decyzji widnieje typ adresu z analizy łańcuchowej (`ReportData.addressTypes`, „stan na zapisany szczyt
   łańcucha”): np. „kontrakt”, „konto Safe”, „EOA z delegacją EIP-7702” wraz z kodem, delegatem (i wpisem rejestru
   delegatów), kontraktem bazowym Safe, EntryPoint lub implementacją proxy — także przy adresach zachowanych i
   ostrzeżeniach; nieudana sonda jest wskazana wprost. Klasyfikacja pochodzi z sieci zapisanej w decyzji (`resolved`)
   albo z zapytań, które decyzja cytuje, nigdy z kolejności listy.
   Trop KYC tylko wtedy, gdy analiza ustaliła autorstwo publikacji (`evidence.kycLead`); inne wzmianki są wymienione
   z autorami jako nieprzesądzające. Interakcje z giełdami są odnotowywane, a nie przypisywane osobie.
5. Aktywność on-chain i przesłanki wyjścia do walut tradycyjnych — wartości w PLN z tabelą, datą i kursem NBP.
   Podrozdział „Klastry adresów Bitcoin” (`ReportData.clusters`, gdy magazyn je przechowuje) przedstawia wynik
   heurystyki wspólnego wydatkowania jako obliczenie, a nie fakt: rozmiar, ziarna, dowody połączeń, pominięte
   transakcje CoinJoin i wspólne z powodem oraz ostrzeżenia (usługa, limit, wzrost). Klastry bez połączeń są
   zliczone jednym zdaniem; powiązania `CLUSTER_ASSOCIATED` nie są liczone jako powiązania własnościowe.
6. Chronologia przepływu środków — zdania w kolejności czasu, zbudowane z transakcji, krawędzi przepływu i zdarzeń
   wyjścia do walut tradycyjnych. Zdarzenie bez pobranej transakcji jest wynikiem reguły, a nie przelewem; wycena
   krawędzi trafia tylko do tego samego przepływu (sieć, transakcja, adresy, aktywo, kwota). Sumy liczą każdy
   przepływ raz (także gdy spełnia kilka reguł), a brak wyceny nigdy nie jest zerem („Brak wyceny w PLN” przy
   wpisie). Krawędzie grafu przepływów (`flows`, zapisane przez etap analizy łańcucha) obejmują także dalsze skoki:
   wpis za bezpośrednim odbiorcą lub przed bezpośrednim nadawcą ma w części obliczeniowej adnotację „Krok przepływu:
   N” (ścieżka wyliczona z chronologii transakcji, nie dowód związku). Przycięcie grafu limitem krawędzi jest podane
   wśród przyczyn niepełności przebiegu (`flow_graph_truncated`).

Adresy są zawsze rozróżniane według sieci i adresu (ten sam adres EVM w Ethereum i Polygon to dwa różne adresy). 7. Zmiany od poprzedniego uruchomienia — alert podmiany adresu portfela z oboma zabezpieczeniami. 8. Rejestr materiału dowodowego — każda strona z adresem URL, czasem pobrania, statusem i skrótami SHA-256 oraz
podsumowanie dziennika połączeń wychodzących. 9. Metodyka i ograniczenia.

Każda treść należy do jednej z trzech klas, renderowanych w osobnych, opisanych blokach (`data-statement="fakty"`,
`"obliczenia"`, `"wnioski"`) z różnym obramowaniem (ciągłe, podwójne, przerywane — czytelne także w druku czarno-białym).
Stanowisko analityka jest czwartą, osobną klasą (`data-statement="ocena-analityka"`, obramowanie kropkowane): oceny
powiązania (aktualna i wcześniejsze, z analitykiem, czasem i uzasadnieniem) przy karcie powiązania — obok wyniku, którego
nie zmieniają; oceny powiązań bez własnej karty (odrzuconych regułą) w osobnym bloku rozdziału 4 — oraz, w ponownej
ocenie, tabela korekt analityka ze zbioru ustalonego przy zleceniu (`config.analystOverrides`). `buildReportData` czyta je z opcjonalnych
portów `judgements` i `overrides`; raport zakończonego przebiegu można wygenerować ponownie (nowa wersja z ocenami
zapisanymi do tej chwili, poprzednie pozostają w magazynie).

### Szkice wniosków AI w sekcji C

Sekcja C („Wnioski wymagające weryfikacji”) może zawierać szkice przygotowane przez model lokalny na prośbę analityka
(zadanie `report-inference-draft`, `packages/llm/README.md`). `buildReportData` dołącza do `ReportData.inferenceDrafts`
wyłącznie szkice **potwierdzone** przez analityka (z poprawionym tekstem lub bez), od najwcześniejszej decyzji;
oczekujące i odrzucone nigdy nie trafiają ani do danych, ani do HTML, ani do modelu raportu — widzi je tylko interfejs
jako „Sugestia AI — niezweryfikowana”. Potwierdzony szkic jest wnioskiem (`origin: 'ai_suggestion'`, pole `ai` z
analitykiem, czasem decyzji, modelem i wersją promptu; `review: 'edited'` i `draftStatement` przy poprawionym tekście)
z etykietą „Wspomagane AI, zatwierdzone przez analityka: {analityk} ({data})”, powołanymi identyfikatorami faktów i
wyników (w HTML z odwołaniem do rejestru dowodów), wyjaśnieniami alternatywnymi i krokami weryfikacji. Szkic nie zmienia
wyników obliczeń, Wskaźnika Pewności ani podsumowania; bez potwierdzonych szkiców HTML jest identyczny jak bez modelu.
Decyzja zleca ponowne wygenerowanie raportu przez tę samą, szeregowaną ścieżkę co każda decyzja o sugestii.

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

`buildReportModel(data)` buduje z tych samych danych (`ReportData`) strukturalny `ReportModel` z `@olcys/core`: fakty
źródłowe, wyniki obliczeń i wnioski (każdy z `requiresVerification`) osobno, blok odtwarzalności, podsumowanie, chronologię
przepływów, zmiany i rejestr dowodów. Zdania pochodzą z katalogu polskiego (`pl.model` i istniejących sekcji), więc
konsola i HTML mówią tym samym językiem. `findPublishedReport` zwraca bieżącą, w pełni opublikowaną wersję raportu (skrót wpisu `export_set` jako id wersji, skróty HTML, danych i eksportów), a `loadReportVersion` — wersję wskazaną id; brak wiersza to `undefined`, raport w starym formacie to `legacy: true`, a nieczytelny blob lub błędny JSON to wyjątek. `ReportModel.coverage` niesie ostrzeżenie o niepełnej analizie (niedostępne strony i powody zgłoszone przez etapy), tak jak raport HTML.

## Raport PDF/A-3b, manifest i podpis

Krok `report.render` może — po zapisaniu HTML, danych i eksportów — wytworzyć raport PDF (`createReportStage({ pdf })`;
w workerze włączany zmienną `GOTENBERG_URL`, wyłączany `OLCYS_REPORT_PDF=false`; `OLCYS_PDF_SIGNING=false` pomija
podpis). `renderReportPdf` robi to w kolejności:

1. `assertSelfContainedHtml` (zewnętrzne odwołanie przerywa przed jakimkolwiek żądaniem).
2. Manifest raportu (`createReportManifest` / `buildReportManifest`): kanoniczny JSON (RFC 8785) z modelem raportu, skrótami
   HTML i danych, zabezpieczeniami (z tokenami RFC 3161) i wersją narzędzia. `reportModelSha256` jest równy skrótowi danych
   raportu wypisanemu w metryce HTML.
3. Gotenberg 9 (`POST /forms/chromium/convert/html`, jedno żądanie): pliki `index.html` i `manifest.json`, etapy
   `attach` (manifest jako plik skojarzony PDF/A-3, relacja `Data`) i `remediate` (profil PDF/A-3b, język `pl-PL`),
   `failOnResourceLoadingFailed` i `failOnConsoleExceptions`. Wymagany nagłówek `Gotenberg-Remediation-Residual: 0`, po
   czym `POST /forms/pdf/validate` musi zwrócić `compliant: true` bez naruszeń. Etapów `sign` i `timestamp` Gotenberga nie
   używamy (klucz w każdym żądaniu i zapytanie do TSA poza klientem ruchu wychodzącego). Zweryfikowano, że pojedyncze
   żądanie z etapami działa w Gotenberg 9.9.1, więc zapasowa ścieżka „konwersja + osobny załącznik” nie jest potrzebna.
4. Podpis przez osint-py (`prepare` → `RFC 3161` przez `TrustedTimestamper` → `finish`, zob. `services/osint-py/README.md`).

Każde wywołanie jest jednym żądaniem klienta ruchu wychodzącego (źródła `gotenberg` i `pdf_signing`, `containsIdentifier:
true`; w trybach `offline` i `replay` bez nagrań). Wynik (`ReportPdfResult`): status `signed_timestamped` (PAdES B-T),
`signed` (B-B: w trybie offline lub gdy TSA jest niedostępne; kolejkowany jest znacznik `report_pdf` dla skrótu podpisanego
pliku, wydawany później przez `tsa:flush`) albo `unsigned` (usługa podpisu niedostępna: PDF i manifest zapisane, jedno
ostrzeżenie `signing_unavailable`, przebieg nie kończy się błędem). Błąd renderowania lub walidacji PDF/A (`PdfRenderError`)
nie przerywa zapisu raportu HTML: przebieg kończy się jako `partial` (kod `pdf_unavailable`).

PDF należy do **tej samej wersji** raportu co HTML: wpis `pdf` w zbiorze `export_set` (a więc w id wersji) niesie skrót,
rozmiar, status podpisu, profil PDF/A i skrót osadzonego manifestu. Konsola i `GET /api/runs/:id/report/view` pokazują go
z jednoznacznym oznaczeniem, że podpis jest **demonstracyjny, niekwalifikowany**; znacznik `report_pdf` wydany później jest
dołączany do listy plików (`pdf_timestamp`) bez zmiany wersji.

**Utwardzenie Gotenberga** (`compose.yml`): Chromium czyta wyłącznie przesłane pliki (`CHROMIUM_ALLOW_LIST=^file:///tmp/.*`,
zakotwiczony wzorzec), odrzuca adresy publiczne i prywatne, bez JavaScriptu; pobieranie z adresu i webhooki wyłączone;
`PDF_DENY_*_IPS` (brak dostępu do TSA); nigdy `CHROMIUM_PROXY_SERVER`. Test integracyjny
(`OLCYS_IT_GOTENBERG=1 GOTENBERG_URL=... pnpm vitest run --project @olcys/reporting`) sprawdza zgodność PDF/A-3b, manifest
w załączniku i brak żądań wychodzących (obraz z `https://example.org`, z `fixture-site` i z nasłuchiwacza testowego).
Zablokowany zasób nie powoduje błędu: PDF powstaje bez obrazu (nawet z `failOnResourceLoadingFailed`).

## Eksporty: STIX 2.1, MISP i CSV

Krok `report.render` zapisuje obok raportu HTML sześć eksportów, zbudowanych z tych samych danych (`ReportData`) co
dokument. Wszystkie pliki (HTML, dane, sześć eksportów: `stix`, `misp`, `csv_links`, `csv_evidence`, `csv_cash_out`,
`csv_changes`) są najpierw zapisywane w magazynie blobów, a dopiero potem rejestrowana jest jedna wersja raportu; ostatni
wpis (`export_set`) wskazuje skrót HTML i skróty eksportów tej wersji. `findExportSet` zwraca eksporty tylko wtedy,
gdy zestaw wskazuje najnowszy raport HTML — nowszy HTML bez eksportów (lub przebieg sprzed eksportów) daje „brak
eksportów”, więc wersje nigdy się nie mieszają. Eksporty są deterministyczne: te same dane dają
identyczne bajty. Zawierają wyłącznie fakty i wyniki obliczeń oraz oceny analityka; wnioski i sugestie modelu AI nie są
eksportowane, więc nie mogą trafić do innego systemu. Domyślnie wyeksportowane są tylko przyjęte powiązania
własnościowe; odrzucone (wykluczone regułą, przypisane przez stronę trzecią) trafiają do STIX i MISP tylko przy
`includeRejected: true`, z adnotacją `x_olcys_rejected` i powodem.

- **STIX 2.1** (`toStixBundle`, `application/stix+json;version=2.1`): tożsamość producenta (`OLCYS_STIX_PRODUCER_NAME`),
  tożsamość osoby (imię i nazwisko ze sprawy, inaczej pierwszy identyfikator zakotwiczony), obserwabla
  `cryptocurrency-wallet` na adres, relacje `related-to` z `confidence` równym Wskaźnikowi Pewności i opisem po polsku,
  obiekty `opinion` z ocen analityka (`same` → `agree`, `not_same` → `disagree`, `unsure` → `neutral`), jeden `report`
  oraz znacznik TLP (`OLCYS_EXPORT_TLP`, domyślnie AMBER) z definicją. Każda relacja ma `external_references` z adresem URL
  i skrótem SHA-256 manifestu każdego zrzutu dowodowego. Uwaga: `cryptocurrency-wallet` nie należy do rdzenia STIX 2.1 —
  to własny typ obserwabli OpenCTI. Identyfikatory obserwabli to UUIDv5 w przestrzeni nazw STIX (§ 2.9) z kanonicznego
  JSON `{"value": adres}`, a pozostałych obiektów — UUIDv5 z identyfikatora raportu i klucza naturalnego. Ten sam adres
  w kilku sieciach daje jedną obserwablę (`x_olcys_chains` wymienia sieci).
- **MISP** (`toMispEvent`, `application/json`): zdarzenie nieopublikowane (`published: false`, `distribution: "0"`,
  tag `tlp:…`), po jednym obiekcie `coin-address` na powiązanie. Tagi adresu: `admiralty-scale:source-reliability`
  (najlepsza ocena wśród przesłanek, które się liczyły), `estimative-language:likelihood-probability` (z określenia
  ICD 203) i `estimative-language:confidence-in-analytic-judgment` (z pewności analitycznej). Każdy adres URL dowodu to
  atrybut `link` z kategorią „External analysis”, `to_ids: false` i skrótem SHA-256 w komentarzu. Obiekt i taksonomie to
  oficjalne pliki MISP dołączone dosłownie w `src/export/misp/` (`template_uuid` i `template_version` pochodzą z
  definicji, atrybuty: `address` dla Bitcoina, `address-xmr` dla Monero, `address-crypto` dla pozostałych sieci,
  `symbol`, `first-seen`, `last-seen`, `text`); odwzorowanie ICD 203 → `likelihood-probability` opisano w `misp/README.md`.
- **CSV** (`toCsv`): UTF-8 z BOM, separator przecinek, końce wierszy CRLF, cytowanie wg RFC 4180, angielskie nagłówki
  snake_case (to dane, nie interfejs). Pliki: powiązania (posortowane malejąco wg wyniku; tylko przyjęte), materiał
  dowodowy, wyjścia do walut tradycyjnych, zmiany. Komórki tekstowe zaczynające się od `=`, `+`, `-`, `@`, TAB lub CR
  dostają przedrostek `'` (ochrona przed wstrzykiwaniem formuł); liczby i `DecimalString` są zapisywane dokładnie tak,
  jak zapisano je w danych (bez liczb zmiennoprzecinkowych).

Tabela `cash_out.csv` ma na końcu kolumnę `pln_synthetic` (`true`, gdy wartość PLN, także któregoś ze składników
zdarzenia zagregowanego, opiera się na kursie syntetycznym; puste, gdy brak wyceny), aby kwoty demonstracyjne nie
przechodziły za oficjalne wyceny NBP. STIX i MISP nie zawierają wartości PLN. Tag `admiralty-scale` uwzględnia tylko
ścieżki, które się liczyły (`counted`).

Zamiast osobnego zadania `report.export` eksporty powstają w kroku `report.render` (potok nie ma kolejki zadań), więc
każde ponowne wygenerowanie raportu tworzy też nowe eksporty z aktualnymi ocenami analityka. Nic nie jest wysyłane do
żadnego systemu zewnętrznego.
