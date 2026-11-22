# Notatki prelegenta

Slajdy: [`olcys-prezentacja.pdf`](olcys-prezentacja.pdf). Wszystkie dane w prezentacji są syntetyczne (niemaskowane).

## 1. Tytuł, problem i cel

OŁCyŚ, czyli Osintowy łapacz cyfrowych śladów, jest narzędziem OSINT dla analityków KAS. Analitycy potrzebują publicznych śladów adresów kryptowalutowych, powiązań, które da się obronić, sygnałów wyjścia do walut tradycyjnych oraz materiału dowodowego do postępowań. Naszym celem jest narzędzie, które te ślady znajduje, ocenia i dokumentuje, a przy tym działa wyłącznie na źródłach publicznych. Cała demonstracja korzysta z fikcyjnej persony i danych syntetycznych.

## 2. Co robi OŁCyŚ

Przepływ zaczyna się od identyfikatorów badanej osoby: nazwy, nicku, e-maila lub adresu. Z włączonych źródeł zbieramy publiczne ślady i wyodrębniamy adresy z weryfikacją sum kontrolnych. Każde powiązanie dostaje Wskaźnik Pewności, a błędne przypisania odrzucają reguły A1–A8. Następnie analizujemy aktywność on-chain z przesłankami wyjścia do fiat w PLN i tworzymy raport. Fakty, obliczenia i wnioski są rozdzielone, a model AI nigdy nie decyduje.

## 3. Demo: sprawa, powiązania, przebieg

Analityk tworzy sprawę z celem, podstawą prawną i zakresem źródeł. Źródła AMBER wymagają uzasadnienia, a identyfikator może być kotwicą, czyli udokumentowanym założeniem. Przebieg analizy pokazuje etapy i liczniki, a wynik trafia do listy powiązanych adresów. Widać tam wynik, przedział i uzasadnienie każdego powiązania.

## 4. Wskaźnik Pewności

Wynik liczymy w dwóch krokach: czy konto należy do osoby oraz czy konto kontroluje adres. Każda przesłanka ma iloraz wiarygodności, osłabiany według wiarygodności źródła. Przedziały to 80–100, 60–79, 40–59, 10–39 i 0, a w demonstracji pojawiają się wyniki 99, 77 i 24. Pewność analityczną podajemy osobno. Wagi są nieskalibrowane, wynik opisuje powiązanie, nie osobę, a model AI nie ma wpływu na wynik, dopóki analityk nie potwierdzi jego sugestii.

## 5. Odrzucanie błędnych przypisań

Wiele adresów w sieci nie należy do osoby, o której mowa w tekście: to adresy depozytowe giełd, usługi, kontrakty czy przykłady z dokumentacji. Reguły A1–A8 oraz weryfikacja sum odrzucają je z podaniem powodu, także homoglify i skróty transakcji. Odrzucenie przeklasyfikowuje adres, zamiast go usuwać, bo wpłata na giełdę jest przesłanką wyjścia do fiat. Panel pokazuje regułę, uzasadnienie i pochodzenie etykiety.

## 6. Wykrywanie wyjścia do fiat

Kwoty są wyceniane w PLN według średniego kursu NBP z ostatniego dnia roboczego przed transakcją. Przesłanki B1–B7 obejmują giełdy, bramki płatnicze, karty, stablecoiny, P2P, mosty i miejsca bez licencji. Przepływ środków śledzimy przez zadaną liczbę przeskoków kontrahentów. Obliczenia na kwotach są dokładne, bez liczb zmiennoprzecinkowych.

## 7. Ponowne analizy i zmiany

Sprawę można analizować ponownie ręcznie lub z harmonogramu, a wynik jest porównywany z poprzednim przebiegiem. W demonstracji system zgłasza alert podmiany adresu portfela w profilu, z BTC-1 na BTC-2. Oś czasu strony łączy przebiegi na żywo z kopiami z Wayback Machine, oznaczonymi jako materiał strony trzeciej. Rescore przelicza zapisane dowody nowymi wagami bez ponownego pobierania.

## 8. Jakość dowodowa

Każda pobrana strona ma manifest z SHA-256, a dziennik wyjść zapisuje pole containsIdentifier przy każdym żądaniu. Skróty są znakowane czasem według RFC 3161. Raport jest podpisanym PDF/A-3b z dołączonym manifestem; podpis jest demonstracyjny i niekwalifikowany, co mówimy wprost. W raporcie fakty (A), obliczenia (B) i wnioski do weryfikacji (C) pozostają rozdzielone.

## 9. Zgodność i bezpieczeństwo

Pracujemy wyłącznie w trybie OSINT, według rejestru źródeł GREEN, AMBER i RED; źródła RED nigdy nie są kontaktowane. Sprawdzamy robots.txt i nie obchodzimy CAPTCHA ani zabezpieczeń antybotowych. Klucze prywatne są usuwane z pamięci, telemetria jest wyłączona, a konsola ma ścisłą politykę CSP. Dziennik dostępu jest tylko do dopisywania, a licencje przechodzą bramkę otwartych licencji. Model AI jest lokalny i wymienny, a jego sugestie mają wagę zero do potwierdzenia przez analityka. Konta użytkowników są poza zakresem MVP i planowane w kolejnej wersji.

## 10. Architektura, technologie i plany

Konsola web komunikuje się z API, które uruchamia pipeline analizy. Cały ruch sieciowy przechodzi przez jeden EgressClient z listą hostów, limitami i dziennikiem. Dane trafiają do PostgreSQL i magazynu blobów, a usługi pomocnicze to osint-py (Maigret, pyHanko), Gotenberg i lokalny model. Stos to Node 26 z TypeScriptem, React, Fastify, PostgreSQL i Python. Kolejne kroki: konta i role, weryfikacja API na żywo, scenariusz z łańcuchami sandbox i podpis kwalifikowany.
