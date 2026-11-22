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
| `review_decision`   | wykryty adres wymagający przeglądu (odtworzony z zaciemnienia, sklejony z fragmentów, OCR) | `confirmed` albo `rejected`                                                       | potwierdzenie usuwa przesłankę `deobfuscated_or_ocr_repaired` i bramkę `review_required`; odrzucenie pomija ten wykryty adres — jego przesłanki nie są liczone                                                                                                                                                        |
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
