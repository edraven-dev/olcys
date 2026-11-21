# fixtures/ — wyłącznie dane syntetyczne

Wszystko w tym katalogu jest **syntetyczne lub zanonimizowane**. Nigdy nie umieszczaj tu prawdziwych imion i nazwisk,
nicków, adresów e-mail, adresów profili ani adresów powiązanych z prawdziwymi osobami. Adresy muszą być wygenerowane od
nowa; nigdy nie używaj adresów z dokumentacji ani wektorów testowych (są na liście odrzucanych).

Portfele demonstracyjne istnieją wyłącznie w lokalnych sieciach testowych uruchamianych w piaskownicy (Bitcoin regtest,
Anvil dla EVM). Żadna transakcja nie trafia do publicznej sieci; dane TRON w demonstracji są w pełni syntetyczne.
Nagrania odpowiedzi z tych sieci są oznaczone jako dane demonstracyjne.

| Katalog      | Zawartość                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `cassettes/` | nagrane wymiany HTTP dla trybów `offline`/`replay`, indeksowane skrótem zapytania                   |
| `labels/`    | etykiety demonstracyjne (gorące portfele giełd, bramki płatnicze) z informacją o pochodzeniu        |
| `corpus/`    | korpus testowy wyodrębniania adresów (przykłady pozytywne, trudne negatywne, zaciemnienia, sekrety) |
