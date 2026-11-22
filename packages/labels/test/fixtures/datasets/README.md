# Syntetyczne zbiory testowe importerów etykiet

Pliki w tym katalogu mają **rzeczywiste formaty** zbiorów (TagPack i ActorPack YAML, lista OFAC JSON, CSV
proof-of-reserves, CSV rejestru ESMA, tekst pozycjonowany rejestru PL), ale **wyłącznie zmyślone dane**: nazwy
oznaczone `SYNTHETIC`, adresy o oczywiście sztucznej treści, numery LEI/KRS/NIP wymyślone na potrzeby testów.
Nie zawierają identyfikatorów prawdziwych osób ani prawdziwych adresów. Plik SQLite eth-labels jest budowany w teście
przez `node:sqlite`.
