# @olcys/scoring

Dwuetapowy Wskaźnik Pewności (Confidence Score) oparty na ilorazach wiarygodności, z wyjaśnieniem wkładu każdej cechy.
Pakiet jest czysty i deterministyczny: nie łączy się z siecią, a zegar i generator identyfikatorów dostaje z zewnątrz.

- **Zależności:** kontrakty `@olcys/core`; `yaml` (odczyt wag), `@noble/curves`, `@noble/hashes`, `@scure/base`
  (weryfikacja podpisów BIP-137).
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/scoring`.

## Publiczne API

- `loadWeights(path?)`, `parseWeights(bytes)` — wczytują i walidują tabelę wag (domyślnie
  `config/scoring/weights.v2.yaml`); `sha256` liczony z surowych bajtów pliku trafia do
  `RunConfigSnapshot.weightsSha256`. `weightsPath(file)`, `DEFAULT_WEIGHTS_FILE`, `featureFamily(key)`.
- `scoreRun(input, weights, { clock, newId })` — główne wejście dla potoku: z kont, przechwyceń, obserwacji, kandydatów
  adresów i decyzji wykluczeń buduje roszczenia (`buildClaims`) i ocenia każde z nich. Zwraca `assessments`
  (`LinkAssessment[]`, posortowane po adresie i relacji) oraz `notes` — powody, dla których zebrany materiał nie stał
  się cechą (`FEATURE_NOTE_CODES`, np. `signature_invalid`, `observation_address_invalid`, `no_identity_path`).
- `buildClaims(input, weights)` — samo mapowanie materiału na roszczenia (`ClaimInput[]`) i notatki.
- `applyOverrides(input, overrides, { candidates? })` — korekty analityka jako dane wejściowe ponownej oceny: wypełnia
  `input.analyst` (`AnalystInputs`: oceny wiarygodności, decyzje o dopasowaniach wymagających przeglądu, przesłanki
  dodane przez analityka z grupą pochodzenia `analyst:<id>` — jedna aktywna na konto, adres i cechę, z najnowszej
  korekty), które `buildClaims` uwzględnia; reszta wejścia się nie zmienia. Odrzucony kandydat nie wraca przez
  potwierdzenie obserwacji jego strony dopasowaniem z innej strony. `candidates` to zapisane kandydaty wskazane przez korekty — po ponownym wyodrębnieniu są odnajdywane po
  przechwyceniu i położeniu. `overridesAt(overrides, queuedAt)`, `overridesVersion(overrides)`
  (`overrides@<liczba>:<id>`), `latestJudgement(judgements)` (aktualna ocena: najnowsza według czasu i id). Zasady:
  [metodyka Wskaźnika Pewności](../../docs/methodology/wskaznik-pewnosci.md).
- `scoreLink(claim, weights, deps)` — ocena jednego roszczenia: `{ ok: true, assessment }` albo
  `{ ok: false, reason: 'invalid_checksum' | 'no_paths' }`.
- Elementy arytmetyki: `scoreHop`, `discount`, `probabilityFromBits`, `combinePaths`, `analyticConfidence`.
- Skale: `icd203Term(p)`, `enfsiTerm(lr)`, `scoreBand(score, rejected)` (`SCORE_BAND_FLOORS`).
- `verifyBip137(address, message, signature)` → `'valid' | 'invalid' | 'unsupported_format'`.
- `normaliseHandle(h)`; stałe `ALGORITHM_VERSION` (`two-hop-llr/1.0.0`) i `RELATION_RULES_VERSION` (`relations.v1`).

## Arytmetyka

Roszczenie to (tożsamość, adres, relacja). Każda ścieżka przechodzi przez jedno konto i ma dwa etapy, które się mnoży:
P(ścieżka) = P(osoba ↔ konto) × P(konto ↔ adres).

- Etap: W = log2(szanse a priori) + Σ log2(BF′), gdzie BF′ = ρ·BF + (1 − ρ), a P = 2^W / (1 + 2^W).
  Szanse a priori: konto 1:9 (−3,17 bita), adres w treści konta 1:4 (−2 bity).
- ρ wynika ze stopnia wiarygodności Admiralty (A 0,95 … E 0,2). Stopień F (także gdy źródło ma w rejestrze F) daje
  `counted: false`, `uncountedReason: 'ungraded'` i bramkę `analyst_grading` — analityk musi najpierw ocenić źródło.
- Kotwica (identyfikator podany przez śledczego dla tej platformy): etap tożsamości ma P = 0,99 jako zapisane założenie
  (bramka `identity_anchor`), bez cech.
- W jednej grupie pochodzenia (konto, a dla kopii archiwalnych — autor oryginału) liczy się tylko najsilniejsza cecha z
  danej rodziny (`e1`–`e4` to rodziny, pozostałe klucze są rodzinami same dla siebie). Powtórzenia zostają widoczne z
  `uncountedReason: 'same_origin_repeat'`.
- Ścieżki łączy noisy-OR: 1 − Π(1 − P). `score = round(100·P)`, `icd203` — termin ICD 203, `enfsiVerbal` — termin ENFSI
  dla ilorazu wiarygodności etapu. `analyticConfidence` (High / Moderate / Low) jest oddzielna od prawdopodobieństwa.

## Synergia śladów i progi ściągawki

- **Synergia:** ten sam adres w niezależnych źródłach podnosi wynik — do noisy-OR wchodzi najsilniejsza ścieżka z każdej
  usługi (platformy). Wielokrotne wystąpienie w jednej usłudze nie jest dodatkowym potwierdzeniem: słabsze ścieżki tej
  samej usługi mają `counted: false`. `LinkAssessment.synergy` podaje niezależne źródła, wynik najsilniejszej pojedynczej
  ścieżki, punkty dodane przez pozostałe źródła oraz liczbę pominiętych powtórzeń.
- **Progi (`band`):** 80–100 `BARDZO_WYSOKIE`, 60–79 `PRAWDOPODOBNE`, 40–59 `SREDNIE`, 10–39 `NISKIE` (wynik poniżej
  10 bez odrzucenia to szum — także `NISKIE`), `WYKLUCZENIE` — link odrzucony przez bramkę, wynik 0.

## Bramki

- Niepoprawna suma kontrolna → brak roszczenia (`invalid_checksum`).
- Relacje `THIRD_PARTY_ATTRIBUTION`, `TX_COUNTERPARTY`, `CLUSTER_ASSOCIATED`: bez ścieżek, wynik 0, `icd203` =
  `not assessed` (nie oceniono), bramka `relation` niespełniona — to inna relacja, a nie słaby dowód posiadania.
  `CLUSTER_ASSOCIATED` powstaje z `FeatureExtractionInput.clusters` (heurystyka wspólnego wydatkowania): członkowie
  klastra, którego ziarno ma roszczenie własności (`SELF_DECLARED`, `PAYMENT_ENDPOINT`, `MENTION_UNCLEAR`); nigdy nie
  podnosi wyniku ziarna ani nie dostaje wag.
- `CUSTODIAL_EXCHANGE` (adres depozytowy giełdy) oraz decyzja wykluczenia `excluded` / `reclassified` (np. A1 etykieta,
  A2 kontrakt, A4 depozyt, A8 lista wykluczeń): wynik prezentowany 0, `band` = `WYKLUCZENIE`. Wynik arytmetyczny
  zostaje w `paths` i `ungated` (np. siła tropu KYC dla adresu depozytowego). Decyzje `flagged` / `kept` są tylko
  odnotowane.
- Informacyjne: `checksum` (schemat i siła), `identity_anchor`, `analyst_grading`, `review_required`,
  `llm_zero_weight` (liczba niepotwierdzonych sugestii LLM — nigdy nie wchodzą do arytmetyki).

## Mapowanie materiału na cechy (`relations.v1`)

- **Ścieżki** mają kotwice oraz konta z co najmniej jedną dodatnią cechą tożsamości. Konta osób trzecich (np. autor
  listy adresów giełd, kanał z ostrzeżeniami) nie tworzą roszczeń posiadania (notatka `no_identity_path`).
- **Cechy tożsamości** (grupa = konto): `exact_username_or_name` (uchwyt równy nickowi / loginowi / identyfikatorowi
  komunikatora po normalizacji albo nazwa równa imieniu i nazwisku — `displayName`, `profile.name`, `profile.display_name`,
  `profile.full_name`, `profile.real_name`, `profile.seller_name`), `profile_link_to_anchor` (`account.link` lub
  `profile.link` wskazujące profil kotwicy), `verified_cross_proof` (`verification.*` wskazujące kotwicę),
  `commit_email_match` (`account.commit_email`), `contact_email_match` (nowa w `weights.v2`: inna obserwacja e-mail
  konta, np. `profile.email`, `profile.public_email`, `post.contact_email`, równa e-mailowi z wejścia),
  `same_avatar_phash` (`profile.avatar_phash`, różnica ≤ 6/64 bitów).
- **Cechy adresu** — obserwacja liczy się tylko, gdy ten sam adres ma poprawny kandydat ekstraktora z tego samego
  przechwycenia. Kandydat z innej strony wystarczy tylko wtedy, gdy łańcuch wynika z samego formatu adresu — sieć EVM
  nigdy nie jest przejmowana z innej strony (notatka `observation_address_unconfirmed`):

| Materiał                                                                                                            | Cecha                         | Stopień | Relacja                 | Poziom |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------- | ----------------------- | ------ |
| `post.signed_message.address` + `text` (lub `message`) + `signature`, podpis BIP-137 poprawny, treść wymienia konto | `e1_cryptographic_binding`    | A       | SELF_DECLARED           | E1     |
| `verification.*_address` (sprawdzenie `valid` lub brak; `unverifiable*` → B)                                        | `e1_cryptographic_binding`    | A       | SELF_DECLARED           | E1     |
| `claim.*drips*_address`, `ens.*_address`                                                                            | `e1_cryptographic_binding`    | A       | SELF_DECLARED           | E1     |
| `profile.*_address` albo adres wewnątrz innego pola `profile.*`                                                     | `e2_self_assertion`           | B       | SELF_DECLARED           | E2     |
| inne `claim.*_address` (`claim.tea*` — pomijane)                                                                    | `e2_self_assertion`           | B       | PAYMENT_ENDPOINT        | E2     |
| wzmianka, pierwszy sygnał `first_person_owner`                                                                      | `e3_ownership_cue`            | C       | SELF_DECLARED           | E3     |
| wzmianka, `payment_request` / `donation`                                                                            | `e3_ownership_cue`            | C       | PAYMENT_ENDPOINT        | E3     |
| wzmianka, `exchange_deposit`                                                                                        | `e3_ownership_cue`            | C       | CUSTODIAL_EXCHANGE      | E3     |
| wzmianka, `listing` / `unclear`                                                                                     | `e3_bare_mention`             | C       | MENTION_UNCLEAR         | E3     |
| wzmianka, `quote`                                                                                                   | `quoted_or_reposted`          | A       | MENTION_UNCLEAR         | E3     |
| wzmianka, `scam_report` / `warning`                                                                                 | osobne roszczenie bez ścieżek | —       | THIRD_PARTY_ATTRIBUTION | E4     |

- Wzmianki konta, które ma już E1/E2 dla tego adresu, nie wnoszą bitów, ale ich relacja zostaje: wpis „wpłaciłem na
  giełdę” obok pola profilu nadal daje relację CUSTODIAL_EXCHANGE. Do wzmianki dochodzą modyfikatory (stopień A):
  `unchecksummed_uncorroborated`, `listing_code_or_docs` (lista, blok kodu, domena dokumentacji),
  `deobfuscated_or_ocr_repaired`.
- **Autorstwo wzmianki:** kotwica posta z ekstraktora (`context.anchor`, np. `msg65000101`) zgodna z postem tego
  przechwycenia o znanym `post.author`; w przeciwnym razie jedyny autor przechwycenia (podmiot obserwacji kont,
  `post.author` albo konto wykryte na tej stronie); dopiero potem ten sam post tej samej platformy w innym
  przechwyceniu. Kopia archiwalna dziedziczy autora oryginału. Bez autora wzmianka nie tworzy roszczenia.
- **Podpis BIP-137** wiąże adres z kontem tylko wtedy, gdy treść wprost wskazuje to konto: zwrot („I am”, „jestem”,
  „user”, „konto” …) z pełnym uchwytem (porównanie po NFC i wielkości liter, bez usuwania znaków diakrytycznych) albo identyfikator konta w kontekście „uid” / „user id” / `u=`. Poprawny podpis
  dowodzi kontroli klucza przez podpisującego, nie przez publikującego: skopiowana wiadomość nie daje E1 (notatka
  `signed_message_unbound`).
- **Konta wykryte kilka razy** (ta sama platforma i identyfikator, albo dokładnie ten sam uchwyt bez identyfikatora —
  podobne uchwyty, np. `demo-user` i `demo_user`, to osobne konta i tylko cecha tożsamości) są scalane: liczą się
  uchwyty, nazwy wyświetlane, adresy profili i strony wykrycia wszystkich rekordów.
- **Relacja roszczenia:** pierwszeństwo CUSTODIAL_EXCHANGE > SELF_DECLARED > PAYMENT_ENDPOINT > MENTION_UNCLEAR (także
  dla wzmianek zastąpionych przez E1/E2); decyzja `reclassified` z relacją ją zastępuje. Poziom = najlepszy poziom cech.

## Przykład (persona syntetyczna, `weights.v2`)

| Adres  | Ścieżki                                                                                                                                                             | Wynik                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| BTC-1  | kotwica forum: podpis BIP-137 (E1) + pole profilu (E2)                                                                                                              | 99, BARDZO_WYSOKIE                   |
| TRON-1 | profil społecznościowy z linkiem do kotwicy, „mój portfel” (50) + ogłoszenie P2P z tym samym loginem, imieniem i nazwiskiem oraz e-mailem, „z mojego portfela” (53) | 77, PRAWDOPODOBNE (+24 pkt synergii) |
| ETH-2  | konto z tym samym nickiem, plik `FUNDING.json` (Drips)                                                                                                              | 24, NISKIE                           |
| ETH-1  | wpis „wpłaciłem na giełdę” (CUSTODIAL_EXCHANGE, A4)                                                                                                                 | 0, WYKLUCZENIE (arytmetycznie 56)    |
| TRON-2 | ostrzeżenie „Uwaga! Oszust…”                                                                                                                                        | 0, nie oceniono                      |

Wagi są nieskalibrowane (`status: uncalibrated`). Każda zmiana wag to nowy plik i nowa wersja; `weights.v2` różni się
od `weights.v1` wyłącznie cechą `contact_email_match`. Wynik opisuje powiązanie, nigdy osobę; decyzje analityka są
zapisywane osobno i nie zmieniają obliczonej oceny.

## Kalibracja

`pnpm --filter @olcys/scoring calibrate [--oracle] [--propose] [--n 20000] [--seed 20261121] [--weights <yaml>]
[--scenarios <yaml>] [--corpus <katalog>|none] [--out data/calibration]` — sprawdzian zgodności prawdopodobieństw
silnika z etykietami na danych syntetycznych: wynik Briera, logarytmiczna funkcja straty, ECE z przedziałami
bootstrapu, diagram niezawodności (SVG), empiryczne ilorazy wiarygodności cech, trafność relacji na korpusie
`fixtures/corpus/` i zestaw kontrolny persony (rozbieżność = kod wyjścia 1). Interfejs biblioteczny: `calibrate`,
`generateClaims`, `oracleScenarios`, `parseScenarios`, `reliabilitySvg`, `proposeWeights` (`src/calibration/`).
Skrypt korzysta z ekstraktora adresów (`@olcys/address-extractor`, tylko jako zależność deweloperska) do pomiaru
relacji na korpusie. Wyniki trafiają do katalogu `data/` (ignorowanego przez git); `--propose` zapisuje wyłącznie
plik propozycji pod katalogiem wyjściowym i nigdy nie zmienia `config/scoring/`. Metoda, ostatnie wyniki i granice:
[metodyka](../../docs/methodology/wskaznik-pewnosci.md#kalibracja-i-jej-granice).
