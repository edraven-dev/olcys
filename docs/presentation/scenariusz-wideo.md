# Scenariusz filmu demonstracyjnego

Film: plik `olcys-demo.mp4` w katalogu głównym repozytorium. Pokazuje zamaskowane dane syntetyczne. Czas całkowity: do 3:00. Znaczniki czasu odpowiadają krokom nagrania.

| Czas      | Krok                         | Narracja                                                                                                                                                                             |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00–0:05 | Plansza tytułowa             | OŁCyŚ, Osintowy łapacz cyfrowych śladów. Narzędzie OSINT dla analityków KAS. Wszystkie dane są syntetyczne.                                                                          |
| 0:05–0:29 | 1. Dane wejściowe (~24 s)    | Analityk tworzy sprawę: wpisuje cel i podstawę prawną, dodaje identyfikatory badanej osoby i oznacza jeden z nich jako kotwicę. Włącza źródła, a źródła AMBER wymagają uzasadnienia. |
| 0:29–0:46 | 2. Wyszukiwanie (~17 s)      | Uruchamiamy analizę. System zbiera publiczne ślady wyłącznie z włączonych źródeł, a każda strona jest zabezpieczana z manifestem i skrótem SHA-256.                                  |
| 0:46–0:59 | 3. Wykrywanie (~13 s)        | Ekstraktor znajduje adresy i weryfikuje sumy kontrolne. Karta sugestii AI jest wyraźnie oznaczona: sugestia ma wagę zero, dopóki analityk jej nie potwierdzi.                        |
| 0:59–1:16 | 4. Wskaźnik Pewności (~17 s) | Każde powiązanie ma wynik, przedział i uzasadnienie. Tu widzimy 99, 77 i 24. Pewność analityczna jest podana osobno, a model AI nie decyduje.                                        |
| 1:16–1:31 | 5. Odrzucone (~15 s)         | Adresy depozytowe giełd, usługi, kontrakty i przykłady z dokumentacji są odrzucane z regułą i uzasadnieniem. Odrzucenie przeklasyfikowuje adres, a nie usuwa go.                     |
| 1:31–1:48 | 6. Aktywność (~17 s)         | Aktywność on-chain z przesłankami wyjścia do fiat. Kwoty są wycenione w PLN według kursów NBP.                                                                                       |
| 1:48–2:20 | Ponowna analiza (~32 s)      | Powtarzamy analizę po zmianie strony. System porównuje przebiegi i zgłasza alert podmiany adresu portfela, a oś czasu pokazuje przebiegi oraz kopie archiwalne.                      |
| 2:20–2:43 | 7. Raport (~23 s)            | Raport rozdziela fakty, obliczenia i wnioski do weryfikacji. Dołączone są skróty plików, a podpisany PDF/A-3b ma podpis demonstracyjny, niekwalifikowany.                            |
| 2:43–3:00 | Plansza końcowa              | OŁCyŚ: tylko źródła publiczne, wyjaśnialny wynik, dowody gotowe do postępowania. Konta użytkowników są planowane w kolejnej wersji. Dziękujemy.                                      |
