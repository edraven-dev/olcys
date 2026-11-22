# Klastrowanie adresów Bitcoin metodą wspólnego wydatkowania — metodyka i ograniczenia

Adresy Bitcoin wydane razem jako wejścia jednej transakcji są zwykle kontrolowane przez jeden podmiot (heurystyka
wielu wejść, Meiklejohn i in. 2013). OŁCyŚ używa jej do jednego celu: pokazać analitykowi adresy, które prawdopodobnie
należą do tego samego portfela co adres badanej osoby. **To wynik heurystyczny (obliczenie), a nie fakt** — nie dowodzi
własności, nie podnosi Wskaźnika Pewności i w raporcie jest opisany jako heurystyka.

## Jak to działa

1. **Ziarna.** Adresy Bitcoin sprawy, które przeszły wstępną selekcję (nie są wykluczone regułami A1/A8) i których
   historię udało się pobrać.
2. **Wspólne wejścia.** Transakcje potwierdzone, w kolejności (wysokość bloku, `txid`); transakcja łączy adresy swoich
   wejść (struktura zbiorów rozłącznych). Wyjścia nigdy nie są łączone z wejściami. Transakcje coinbase i wejścia bez
   adresu są pomijane. Wynikiem jest klaster każdej grupy ziaren (także klaster jednoelementowy).
3. **Rozszerzenie.** Historie partnerów wspólnego wydatkowania są pobierane tym samym klientem ruchu wychodzącego
   i tymi samymi dostawcami co pozostałe dane łańcuchowe (z zapisem w dzienniku, `containsIdentifier: true`), w
   granicach: najwyżej 200 adresów, głębokość 2 (partner partnera), do 5 stron historii na adres. Nigdy nie są
   pobierane adresy oznaczone jako usługa (A1) ani z listy wykluczeń (A8). Niepełne historie partnerów oznaczają
   przebieg jako `partial` (kod `counterparty_chain_incomplete`). Wymaga to włączonego dostawcy Bitcoin w zakresie
   sprawy; w środowisku produkcyjnym należy używać własnego węzła lub instancji Esplora.
4. **Identyfikator i kolejność.** Identyfikator klastra to `c_` i 16 znaków szesnastkowych SHA-256 z posortowanej listy
   adresów (rozdzielonych znakiem nowej linii); lista adresów jest sortowana, więc kolejność transakcji na wejściu nie
   zmienia wyniku. Dowód połączenia adresu to pierwsza transakcja łącząca go z ziarnami (przeszukiwanie wszerz).

## Bezpieczniki

| Bezpiecznik                            | Działanie                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CoinJoin typu Wasabi                   | co najmniej 11 równych wyjść (`config/rules/exclusion.v1.yaml`, A6) — transakcja pominięta (`coinjoin_wasabi`)                           |
| CoinJoin typu Whirlpool                | 5 wejść i 5 równych wyjść o nominale puli, wejście z tx0 (OP_RETURN) lub z miksu — pominięta (`coinjoin_whirlpool`)                      |
| Równe wyjścia (np. JoinMarket)         | co najmniej 3 wyjścia o tej samej wartości stanowiące co najmniej połowę wyjść — pominięta (`equal_outputs`)                             |
| Transakcja wspólna                     | wejścia ≥ 2 adresów tworzą wyjście P2WSH albo wejście ujawnia skrypt z `OP_CHECKMULTISIG` — pominięta (`collaborative_escrow`)           |
| Usługa oznaczona etykietą              | adres osoby wydany razem z usługą: usługa nie dołącza do klastra, jej inni partnerzy nie są łączeni; zapis w `serviceMembers`, reguła A7 |
| Limit rozmiaru                         | domyślnie 1000 adresów; połączenie przekraczające limit jest pomijane (`cap_reached`), klaster oznaczony `capped`                        |
| Wzrost względem poprzedniego przebiegu | `growthFactor` = rozmiar / poprzedni rozmiar tego samego ziarna; od 100 reguła A7 oznacza klaster                                        |

Limit rozmiaru działa na całe transakcje: transakcja, która podniosłaby składową ponad limit, jest pomijana w całości
(zachowanie konserwatywne), a transakcje są przetwarzane w kolejności (wysokość bloku, `txid`), więc wynik zależy od tej
kolejności, a nie od kolejności danych wejściowych.

Reguła A7 tylko **oznacza** (`flagged`) adresy ziaren — nie wyklucza ich. Progi (11 równych wyjść, nominały pul,
limit 1000, wzrost 100) są wartościami startowymi, niekalibrowanymi, i leżą w `config/rules/exclusion.v1.yaml`.

## Czego nie robimy

- **Brak heurystyki adresu reszty.** Jest znacznie mniej bezpieczna (błędne połączenie jednego adresu zapada klaster);
  adres reszty nie jest łączony z wejściami.
- Brak klastrowania innych łańcuchów UTXO.
- Klaster nie tworzy powiązania z osobą: jego członkowie są zapisywani jako `CLUSTER_ASSOCIATED` (wynik 0, „nie
  oceniono”) i tylko wtedy, gdy ziarno ma roszczenie własności; żaden adres usługi nie łączy dwóch osób.

## Ograniczenia, o których musi wiedzieć analityk

- **Fałszywe połączenia.** Möser i Narayanan (2022) pokazują, że nawet znikomy odsetek błędnych połączeń (0,044 %)
  zapada klastry; wniosek z klastra to wskazówka do dalszego sprawdzenia, nie dowód.
- **CoinJoin nadal istnieje** po zajęciach z 2024 r.: Wasabi działa przez niezależnych koordynatorów (zkSNACKs
  zakończył działalność 1 czerwca 2024 r.), Ashigaru uruchomił ponownie Whirlpool w czerwcu 2025 r., JoinMarket działa
  jako JoinMarket NG. Wykrywanie opiera się na kształcie transakcji; nowe protokoły i warianty mogą go nie spełniać.
- **PayJoin i transakcje wspólne** (np. depozyty Bisq, kanały z podwójnym finansowaniem) łączą wejścia różnych
  podmiotów; PayJoin nie jest wiarygodnie wykrywalny, więc klaster może zawierać cudze adresy.
- **Wspólne wydatkowanie to założenie**, a nie obserwacja własności. Opracowanie z 2026 r. kwestionuje wiarygodność
  heurystyki wielu wejść w postępowaniach organów ścigania — raport przedstawia klastry wyłącznie jako heurystykę.
- Test Whirlpool wymaga transakcji poprzedzającej; gdy jej nie pobrano, transakcja 5×5 jest pomijana jako „równe
  wyjścia” (zachowanie konserwatywne).
- Pobrane historie są ograniczone (strony, limit adresów): klaster z niepełnych danych może być mniejszy niż w
  rzeczywistości, a przebieg jest wtedy oznaczony jako częściowy.
