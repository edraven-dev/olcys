/** Polish captions of the demo video. Placeholders `{x}` are filled from the demo manifest at run time. */
export const captions = {
  titleCard: {
    title: 'OŁCyŚ — Osintowy łapacz cyfrowych śladów',
    subtitle: 'demonstracja na danych syntetycznych',
  },
  endCard: {
    title: 'OŁCyŚ — wynik to wsparcie dla analityka, nie decyzja',
    subtitle: 'Wszystkie dane w nagraniu są syntetyczne · źródła publiczne · ruch tylko lokalny',
  },
  syntheticBadge: 'DANE SYNTETYCZNE — demonstracja',
  fast: 'przyspieszone ×{factor}',
  steps: {
    input: {
      title: 'Krok 1 z 7: dane wejściowe sprawy',
      detail: 'Cel, podstawa prawna, identyfikatory i zakres źródeł (RED nigdy, AMBER z uzasadnieniem)',
    },
    search: {
      title: 'Krok 2 z 7: wyszukiwanie OSINT w źródłach publicznych',
      detail: 'Każde zapytanie jest zapisane w dzienniku połączeń; ruch wychodzi tylko do lokalnej strony testowej',
    },
    detection: {
      title: 'Krok 3 z 7: wykrywanie i weryfikacja adresów',
      detail: 'Suma kontrolna, sieć i zabezpieczony dowód; błędne kandydaty są odrzucane',
    },
    score: {
      title: 'Krok 4 z 7: Wskaźnik Pewności powiązania',
      detail: 'Wynik {scores} — wspiera ocenę analityka, nie zastępuje jej',
    },
    rejected: {
      title: 'Krok 5 z 7: odrzucone błędne przypisania',
      detail: 'Giełdy, kontrakty i strony trzecie nie są majątkiem osoby — reguły {rules}',
    },
    activity: {
      title: 'Krok 6 z 7: aktywność on-chain i wyjście do fiat',
      detail: 'Wpłata na giełdę (B1) wyceniona w PLN według kursu średniego NBP',
    },
    rerun: {
      title: 'Dodatkowo: ponowna analiza i wykrycie zmian',
      detail: 'Podmiana adresu portfela w profilu: {from} → {to}',
    },
    report: {
      title: 'Krok 7 z 7: źródła i raport końcowy',
      detail: 'Fakty, obliczenia i wnioski do weryfikacji — osobno, z odtwarzalnymi parametrami',
    },
  },
} as const;
