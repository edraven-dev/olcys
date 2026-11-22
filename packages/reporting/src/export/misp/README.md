# Dane MISP (podzbiór)

Pliki `coin-address.definition.json` i `taxonomies.json` zawierają podzbiór opisu obiektu `coin-address` (projekt MISP
objects) oraz wartości taksonomii `admiralty-scale`, `estimative-language` i `tlp` (projekt MISP taxonomies), potrzebne
do zbudowania zdarzenia MISP. Licencja danych: CC0-1.0 lub BSD-2-Clause (do wyboru) — zob.
`docs/compliance/licenses.md`.

Podzbiór został spisany ręcznie, bez pobierania z sieci (narzędzie nie sięga do zewnętrznych repozytoriów). Pola
`uuid` i `version` w `coin-address.definition.json` są **wartościami zastępczymi** (UUID zerowy, wersja 1) i muszą
zostać zastąpione wartościami z aktualnego `objects/coin-address/definition.json` przy odświeżeniu danych na maszynie z
dostępem do repozytorium MISP; eksport kopiuje je do `template_uuid` i `template_version` bez zmian.
