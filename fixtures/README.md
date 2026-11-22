# fixtures/ — wyłącznie dane syntetyczne

Wszystko w tym katalogu jest **syntetyczne lub zanonimizowane**. Nigdy nie umieszczaj tu prawdziwych imion i nazwisk,
nicków, adresów e-mail, adresów profili ani adresów powiązanych z prawdziwymi osobami. Adresy muszą być wygenerowane od
nowa. Adresy z dokumentacji i wektorów testowych występują wyłącznie jako opisane w manifeście wabiki, które sprawdzają
listę odrzucanych adresów.

Historia transakcji persony jest w pełni syntetyczna: strona testowa serwuje ją w formatach Esplora, Etherscan V2
i TronGrid, a żadna z tych transakcji nie istnieje w publicznej sieci. Klucze prywatne powstają tylko w pamięci
generatora (podpis wiadomości) i nigdy nie są zapisywane.

| Katalog        | Zawartość                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cassettes/`   | nagrane wymiany HTTP dla trybów `offline`/`replay`, indeksowane skrótem zapytania                                                                                                                                                                                            |
| `persona/`     | manifest syntetycznej persony (adresy, podpis, wabiki, oczekiwane wyniki, skróty plików) i wektory testowe podpisów BIP-137; generowane przez `pnpm --filter @olcys/fixture-site fixtures:generate`                                                                          |
| `labels/`      | etykiety demonstracyjne (gorące portfele giełd, bramki płatnicze) z informacją o pochodzeniu; `demo-curated.json` powstaje razem z personą                                                                                                                                   |
| `prices/`      | syntetyczne miesięczne ceny referencyjne BTC/USD i ETH/USD do wyceny w demonstracji (to nie są dane rynkowe); `demo-prices.v1.json`, CC0-1.0                                                                                                                                 |
| `corpus/`      | syntetyczny korpus wyodrębniania adresów z prawdą wzorcową (opis w `corpus/README.md`); generowany przez `pnpm --filter @olcys/address-extractor corpus:generate`                                                                                                            |
| `calibration/` | syntetyczne scenariusze (`scenarios.v1.yaml`) i zestaw kontrolny persony (`persona.v1.yaml`) dla sprawdzianu kalibracji Wskaźnika Pewności; polecenie `pnpm --filter @olcys/scoring calibrate`, wyniki w `data/calibration/` (opis: `docs/methodology/wskaznik-pewnosci.md`) |
