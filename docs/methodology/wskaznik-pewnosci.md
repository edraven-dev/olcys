# Wskaźnik Pewności — metodyka

Wskaźnik Pewności (0–100) opisuje prawdopodobieństwo powiązania identyfikatora ze sprawy z adresem kryptowalutowym —
nigdy osobę. Liczony jest dwuetapowo: (1) czy konto internetowe należy do osoby, (2) czy konto kontroluje adres; każda
przesłanka ma iloraz wiarygodności (BF) osłabiany według wiarygodności źródła (ρ, skala Admiralicji). Wzory, poziomy
dowodów, bramki i przykład obliczeń opisują [architektura](../architecture.md) (sekcja „Wskaźnik Pewności
(podsumowanie)”) oraz [pakiet punktacji](../../packages/scoring/README.md); wagi są w `config/scoring/weights.v2.yaml`.

Wynik wspiera ocenę analityka — nie zastępuje jej. System liczy, analityk decyduje: jego oceny i korekty są zapisywane
osobno od obliczeń i nigdy nie zmieniają zapisanego wyniku.

## Ocena i korekty analityka

### Ocena powiązania

Analityk może zapisać ocenę każdego powiązania (karta powiązania w zakładce „Powiązane adresy”,
`POST /api/links/:linkId/judgements`):

| Wartość    | Etykieta                | Znaczenie                                                     |
| ---------- | ----------------------- | ------------------------------------------------------------- |
| `same`     | Powiązanie potwierdzone | Konto i adres należą do badanej osoby — ocena analityka       |
| `not_same` | Powiązanie odrzucone    | Konto lub adres nie należy do badanej osoby — ocena analityka |
| `unsure`   | Niepewne                | Dowody nie pozwalają rozstrzygnąć                             |

- Każda ocena ma uzasadnienie (10–2000 znaków po przycięciu spacji), analityka i czas zapisu. Analityk pochodzi
  z konfiguracji serwera (`OLCYS_ANALYST_NAME`, w razie braku `OLCYS_COLLECTOR_NAME`, domyślnie `analyst`; po
  wprowadzeniu uwierzytelniania — zalogowany użytkownik), nigdy z treści żądania.
- Ocena jest zapisywana **obok** wyniku i nie zmienia obliczonego Wskaźnika Pewności: ani wyniku, ani określenia
  ICD 203, bramek, przedziału, ani zdarzeń `SCORE_CHANGED` porównania przebiegów. Nie uruchamia ponownych obliczeń.
- Ocen może być kilka; aktualna jest najnowsza (według czasu, a przy równym czasie — identyfikatora). Wcześniejsze
  oceny pozostają zapisane i widoczne.
- Raport pokazuje oceny jako osobny rodzaj stwierdzeń („Oceny analityka”) obok wyników obliczeń — przy karcie
  powiązania, przy karcie przypisania przez stronę trzecią albo, dla powiązań odrzuconych regułą, w osobnym bloku
  rozdziału 4; każda ocena pojawia się dokładnie raz. Raport jest dokumentem stałym: przycisk „Wygeneruj raport
  ponownie” (`POST /api/runs/:runId/report`) tworzy jego nową wersję z ocenami zapisanymi do tej chwili; poprzednie
  wersje pozostają w magazynie.

### Korekty materiału dowodowego

Korekta analityka jest daną wejściową do obliczeń, a nie zmianą wyniku (`POST /api/cases/:caseId/overrides`, formularz
„Korekta analityka” w rozwijanym uzasadnieniu powiązania):

| Rodzaj              | Dotyczy                                                                                    | Wartość                                                                           | Skutek w ponownej ocenie                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reliability_grade` | jedna obserwacja, jeden wykryty adres albo jedno źródło                                    | ocena A–E (oceny F nie można ustawić)                                             | przesłanki z tego elementu dostają ocenę analityka (ρ według skali), opis przesłanki wskazuje analityka; pierwszeństwo ma ocena obserwacji, potem wykrytego adresu, potem źródła, a dla tego samego elementu — najnowsza                                                                                              |
| `review_decision`   | wykryty adres wymagający przeglądu (odtworzony z zaciemnienia, sklejony z fragmentów, OCR) | `confirmed` albo `rejected`                                                       | potwierdzenie usuwa przesłankę `deobfuscated_or_ocr_repaired` i bramkę `review_required`; odrzucenie pomija ten wykryty adres — jego przesłanki nie są liczone, a obserwacje z tej strony nie są potwierdzane dopasowaniem z innej strony                                                                             |
| `add_evidence`      | konto ze ścieżki powiązania (i adres — dla etapu adresu)                                   | `contradicting_attribute`, `second_independent_origin` albo `onchain_consistency` | jedna przesłanka o tym kluczu: `contradicting_attribute` na etapie tożsamości konta, pozostałe na etapie adresu ścieżki konta; grupa pochodzenia `analyst:<id korekty>`, ocena domyślna cechy z pliku wag (B dla `second_independent_origin`), opis wskazuje korektę i analityka (uzasadnienie zostaje przy korekcie) |

- Korekta musi dotyczyć elementu z przebiegu tej sprawy (obserwacji, konta, wykrytego adresu, źródła lub adresu
  ocenionego powiązania); inne klucze przesłanek są odrzucane (`feature_not_allowed`).
- Korekta niczego nie zmienia od razu. Uwzględnia ją dopiero **ponowna ocena zapisanych danych** (`rescore`: przycisk
  „Uruchom ponowną ocenę (rescore)” albo `POST /api/cases/:caseId/runs` z `{ "trigger": "rescore", "rescoreOfRunId" }`),
  która stosuje korekty sprawy zapisane do chwili jej zlecenia. Ich zbiór jest ustalany raz, przy zleceniu: parametry
  przebiegu zapisują identyfikatory korekt (`analystOverrides`) i etykietę `rulesVersions.overrides =
  overrides@<liczba>:<id najnowszej>`, a punktacja i raport korzystają dokładnie z tego zbioru — korekta zapisana
  później nie zmienia już zleconego przebiegu. Ponowna ocena tworzy nowy, osobno wersjonowany wynik (raport pokazuje
  korekty w metryce i w tabeli „Korekty analityka uwzględnione w tym przebiegu”).
- Przebiegi zbierające dane (ręczne i z harmonogramu) korekt nie stosują — oceniają materiał w postaci zebranej.
- Ponowna ocena wyodrębnia adresy ponownie, więc wykryty adres ma w niej nowy identyfikator; korekta odnajduje go po
  zabezpieczeniu strony i położeniu w tekście. Korekty dotyczą elementów materiału, które wskazują — nowy przebieg
  zbierający ma nowe elementy.
- Dla jednego elementu liczy się najnowsza korekta: ocena wiarygodności tej samej obserwacji, wykrytego adresu lub
  źródła, decyzja o tym samym dopasowaniu, a przy `add_evidence` — jedna aktywna przesłanka na konto, adres i klucz
  cechy (ponowne zapisanie tej samej przesłanki nie dodaje jej wagi drugi raz). Wcześniejsze korekty pozostają
  zapisane w historii sprawy.
- Etap tożsamości konta-kotwicy jest zapisanym założeniem (P = 0,99) i nie przyjmuje przesłanek.
- Korekty reguł odrzucania (A1–A8) wykraczają poza ten zakres.

### Ślad audytowy

- Oceny, korekty i wyniki są tylko do dopisywania: rola aplikacji (`olcys_app`) ma w tabelach `analyst_judgements`,
  `analyst_overrides` i `link_assessments` wyłącznie prawa SELECT i INSERT. Żadna ścieżka kodu nie aktualizuje
  zapisanego wyniku.
- Każda ocena i korekta jest odnotowywana w dzienniku serwera (analityk, rodzaj, identyfikatory) — bez uzasadnień
  i bez treści pobranych ze stron.
- Sugestie modelu językowego mają wagę 0 do czasu potwierdzenia przez analityka; ocena ani korekta nie korzystają
  z modelu językowego.

## Kalibracja i jej granice

Wagi (`config/scoring/weights.v2.yaml`) są wartościami wyjściowymi: dla cech łączących konta i adresy z tożsamością nie
istnieją opublikowane, zwalidowane ilorazy wiarygodności, a status wag pozostaje **„nieskalibrowane”**
(`status: uncalibrated`). Pakiet punktacji zawiera więc powtarzalny sprawdzian, który mierzy, na ile prawdopodobieństwa
silnika zgadzają się z częstością prawdziwych powiązań w danych o znanej prawdzie, i nic poza tym:

```bash
pnpm --filter @olcys/scoring calibrate                   # scenariusze z fixtures/calibration/scenarios.v1.yaml
pnpm --filter @olcys/scoring calibrate --oracle          # dane losowane z samych wag (kontrola mechaniki)
pnpm --filter @olcys/scoring calibrate --oracle --propose  # dodatkowo propozycja wag (tylko pod --out)
```

Wyniki trafiają do `data/calibration/<algorytm>/<wagi>/<ziarno>[-oracle]/` (katalog ignorowany przez git):
`report.json`, `reliability.svg` (diagram niezawodności) i `report.md`. Raport zawiera SHA-256 wag, wersje algorytmu
i reguł, SHA-256 zbioru danych oraz seed; te same dane wejściowe i ten sam seed dają identyczne bajty.

### Metoda

- **Generator** (z seedem, deterministyczny) tworzy na poziomie silnika roszczenia z etykietą: 1 — prawdziwe
  powiązanie własnościowe, 0 — fałszywe. Cechy są losowane niezależnie (Bernoulli), kopie tej samej cechy mogą
  pochodzić z jednej lub wielu grup pochodzenia (sprawdzenie, że lustrzane kopie nie są liczone wielokrotnie).
  Roszczenia `THIRD_PARTY_ATTRIBUTION` nie są generowane (nie są oceniane).
- **Tryb `oracle`:** częstość cechy w klasie prawdziwej i fałszywej tak, by m / u = BF′ (iloraz po osłabieniu według
  wiarygodności), a priorytety klas równe priorytetom z wag (identyfikator kotwicy: 0,99). Poprawny silnik musi być tu
  skalibrowany, więc tryb sprawdza generator, bufory deduplikacji i arytmetykę, **nie wagi**. Silnik z założenia traktuje brak
  cechy jako neutralny (iloraz 1); to założenie silnika, a nie dostrojenie sprawdzianu, i jest poprawne tylko dla cech rzadkich, dlatego w tym trybie cechy muszą być rzadkie (największa różnica częstości między
  klasami: 0,04); przy częstszych cechach średnia prognoza systematycznie przewyższa obserwowaną.
- **Tryb `scenarios`:** osiem scenariuszy z ręcznie przyjętymi założeniami (prawdziwy właściciel z kotwicą, konto
  o tej samej nazwie z linkiem w profilu, ta sama nazwa i dowód kryptograficzny należący do obcej osoby, cytowany
  adres, lista lub dokumentacja, stopka z darowiznami, wzmianka o wpłacie na giełdę, kopie lustrzane). Etykieta
  wpłaty na giełdę to 0: adres depozytowy nie jest prywatnym portfelem podmiotu, więc bramka silnika (wynik 0) jest
  poprawną odpowiedzią.
- **Miary:** wynik Briera, logarytmiczna funkcja straty (logarytm naturalny, prawdopodobieństwo obcięte do
  [1e-15, 1 − 1e-15]), ECE na 10 przedziałach równej szerokości, przedziały ufności 95 % z 1000 powtórzeń bootstrapu.
  Dla każdej cechy: empiryczny iloraz wiarygodności `((n₁ + 0,5)/(N₁ + 1)) / ((n₀ + 0,5)/(N₀ + 1))` obok BF i BF′;
  dla cech etapu tożsamości lub adresu klasą jest prawda tego etapu, a nie całego powiązania.
- **Ostrzeżenia:** `overconfident:<scenariusz>` (średnia prognoza przewyższa obserwowaną o więcej niż 0,1 przy n ≥ 200),
  `sparse:<cecha>` (mniej niż 30 wystąpień w jednej z klas), `corpus_missing`, `persona_mismatch:<roszczenie>`.
- **Trafność relacji:** każdy dokument korpusu `fixtures/corpus/` jest wyodrębniany ekstraktorem adresów, owijany
  w syntetyczne konto-kotwicę i przetwarzany przez `buildClaims`; relacja każdego adresu jest porównywana z relacją,
  do której prowadzi rola z prawdy wzorcowej (tabela sygnał → relacja z reguł `relations.v1`). To miara łańcucha
  „wykrycie sygnału roli → relacja”, nie wag.
- **Zestaw kontrolny persony** (`fixtures/calibration/persona.v1.yaml`): BTC-1 = 99, TRON-1 = 77, ETH-2 = 24 oraz
  przykład z tej metodyki, 50 i 62. Rozbieżność kończy polecenie kodem 1 (strażnik regresji wag i algorytmu).
- **Propozycja wag** (`--propose`): plik `weights.v2-proposed.yaml` powstaje wyłącznie pod katalogiem wyjściowym.
  Cechy z co najmniej 30 wystąpieniami w obu klasach dostają BF odwrócony z empirycznego LR (silnik sam stosuje
  osłabienie ρ, więc zmierzony iloraz jest już osłabionym BF′), obcięty do [1/1024, 1024] i zaokrąglony do 3 cyfr;
  reszta jest kopiowana. Zatwierdzenie pliku jako nowej wersji wag jest decyzją człowieka — kod nigdy nie zmienia
  `config/scoring/`.

### Ostatnie wyniki (dane syntetyczne, wagi `weights.v2`, algorytm `two-hop-llr/1.0.0`, n = 20 000, seed 20261121)

| Miara                         | `oracle`                  | `scenarios`               |
| ----------------------------- | ------------------------- | ------------------------- |
| Brier                         | 0,0494 (CI 0,0471–0,0516) | 0,1262 (CI 0,1241–0,1282) |
| Logarytmiczna funkcja straty  | 0,1798 (CI 0,1729–0,1871) | 0,3707 (CI 0,3653–0,3761) |
| ECE                           | 0,0098 (CI 0,0072–0,0132) | 0,0855 (CI 0,0807–0,0901) |
| Średnia prognoza / obserwacja | 0,073 / 0,065             | 0,372 / 0,404             |

- W trybie `oracle` ECE jest poniżej 0,03, a różnica średnich poniżej 0,01; cechy z co najmniej 500 wystąpieniami mają
  empiryczny LR w granicach 15 % od BF′. Silnik i deduplikacja zachowują się więc zgodnie z modelem, gdy dane
  pochodzą z modelu.
- W trybie `scenarios` wysoki ECE wynika z założeń scenariuszy, a nie z błędu mechaniki: prognozy są zgrupowane przy
  kilku wartościach (np. 0,53 dla wielu roszczeń), a scenariusze mają stałe etykiety (np. stopka z darowiznami: prognoza
  0,505, założona prawda 1). Ostrzeżenie `overconfident:same_nick_stranger_with_proof` pokazuje coś istotnego: ta
  sama nazwa konta z poprawnym dowodem kryptograficznym, należącym do obcej osoby, dostaje wynik 24 („mało
  prawdopodobne”), a założona prawda wynosi 0. Wynik ten jest właściwą reakcją na małą wiarygodność etapu tożsamości,
  ale analityk nie może go czytać jako „prawie wykluczone”.
- Kopie lustrzane pochodzące z jednej grupy pochodzenia dają prognozę 0,560 wobec zaobserwowanych 0,563 przy założonych 0,56 (silnik liczy je raz);
  gdy każda kopia ma własną grupę (symulowane podwójne liczenie), scenariusz dostaje ostrzeżenie `overconfident`.
- Trafność relacji na korpusie: makro-F1 0,827 (n = 1200 adresów). Najczęstszy błąd to rola „pierwsza osoba” lub „prośba
  o wpłatę” odczytana jako wzmianka bez wyraźnej roli (`MENTION_UNCLEAR`: 84 z 278 deklaracji własności i 41 z 379
  punktów płatności); wykrywanie sygnału roli jest więc ograniczeniem łańcucha, nie wag.
- Zestaw kontrolny persony: 5 z 5 wartości odtworzonych.

### Granice

- **To nie jest kalibracja wobec rzeczywistości.** Etykiety i częstości cech pochodzą z generatora, czyli z naszych
  założeń. Sprawdzian wykrywa błędy mechaniki (arytmetyka, deduplikacja, bramki, odwzorowanie cech) i pokazuje
  konsekwencje założeń, ale nie dowodzi, że BF odpowiadają rzeczywistym ilorazom wiarygodności.
- W trybie `scenarios` empiryczne LR cech odzwierciedlają założenia scenariuszy (cechy przypisane do scenariuszy z góry),
  więc propozycja wag z tego trybu to echo założeń; porównanie z wagami ma sens tylko w trybie `oracle`.
- Brak cechy jest dla silnika neutralny, mimo że w rzeczywistości bywa informacją; tryb `oracle` obchodzi to rzadkością
  cech, a nie poprawia modelu. Przyjęto też niezależność cech wewnątrz etapu poza regułą jednej cechy na rodzinę
  i grupę pochodzenia.
- Dopóki nie będzie rzeczywistych, oznaczonych przypadków (wymagają podstawy prawnej i opracowania przez ekspertów),
  wagi zachowują status **„nieskalibrowane”**, a Wskaźnik Pewności należy czytać jako uporządkowaną miarę wspierającą
  decyzję analityka, nie jako częstość prawdziwych powiązań.
- **Znane ograniczenie: konto o tej samej nazwie z poprawnym dowodem kryptograficznym.** Silnik ocenia dwa etapy osobno:
  dowód kryptograficzny potwierdza, że konto kontroluje adres, ale etap tożsamości (sama zgodność nazwy, iloraz 3
  przy priorytecie 1:9) pozostaje słaby, więc iloczyn daje około 24 („mało prawdopodobne”), a nie wartość bliską 0.
  To skutek przyjętej konstrukcji, a nie błąd arytmetyki; sprawdzian zgłasza go jako
  `overconfident:same_nick_stranger_with_proof`. Czy etap tożsamości powinien silniej obniżać wynik w takim przypadku,
  jest pytaniem projektowym i wymaga decyzji; ta wersja silnika się nie zmienia.
