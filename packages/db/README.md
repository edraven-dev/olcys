# @olcys/db

Schemat PostgreSQL, migracje SQL i typowane repozytoria dla magazynu dowodów działającego w trybie tylko do dopisywania (append-only).

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/db`.

## Publiczne API

- `createDb(url)` — instancja Kysely związana ze schematem `olcys`.
- `createMemoryRepositories()` — implementacja tych samych portów w pamięci (testy, demonstracja bez bazy).
- `createSqlRepositories(db)` — implementacje SQL portów repozytoriów z `@olcys/core` (`cases`, `runs`, `evidence`,
  `chain`, `addressTypes`, `analysis`, `labels`, `schedules`, `judgements`, `overrides`, `custody`, `llm`). Dowody są tylko do
  dopisywania; rola `olcys_app` nie ma praw UPDATE/DELETE.
- `schedules` (migracja `0002_schedules.sql`) — `setSchedule` zastępuje `cases.schedule` (poza statusem jedyna kolumna
  sprawy z prawem UPDATE) i w tej samej transakcji dopisuje zmianę do `case_schedule_change` (kto, dlaczego, przed, po);
  `fire` zajmuje termin wpisem `schedule_tick` z unikalnym `job_id` pod blokadą doradczą sprawy (tę samą blokadę bierze
  `setSchedule`), więc termin uruchamia najwyżej jeden przebieg także przy kilku procesach, i nie uruchamia go, gdy
  przebieg sprawy jest w kolejce lub w toku. Decyzja dostaje czas ostatniej zmiany harmonogramu i ostatni obsłużony
  termin; decyzja `not_due` (termin już nienależny) niczego nie zapisuje. Obie tabele są tylko do dopisywania.
- `labels.upsert` pomija dokładny ponowny import etykiety; poprawiona wersja rekordu z tego samego zbioru danych jest
  zapisywana jako nowy wiersz, a `labels.list()` zwraca najnowszą wersję (wg `lastmod`) dla każdej kombinacji adresu,
  podmiotu i zbioru.
- `judgements`, `overrides` (migracja `0003_analyst_overrides.sql`) — oceny analityka przy powiązaniach
  (`analyst_judgements`) i korekty analityka w sprawie (`analyst_overrides`, cel korekty w `jsonb`); listy od
  najstarszego wpisu (czas, id). Obie tabele i `link_assessments` są tylko do dopisywania (`olcys_app`: SELECT
  i INSERT). `analysis.getLink(id)` zwraca jedno powiązanie dowolnego przebiegu.
- `addressTypes` (migracja `0004_address_types.sql`) — typy adresów z analizy łańcuchowej w tabeli
  `address_type_classification`: jeden wiersz na przebieg i adres (`UNIQUE (run_id, chain, address)`), typ (lista
  kontrolowana `CHECK`), prefiks i długość kodu, delegat EIP-7702, kontrakt bazowy Safe, EntryPoint ERC-4337,
  implementacja ERC-1967, typ skryptu UTXO, nieudana sonda (`jsonb`) oraz `fetch_ids uuid[]` — zapytania w kolejności
  wykonania. `add(runId, klasyfikacje)` odrzuca adres sklasyfikowany już w tym przebiegu, `list(runId)` zwraca wiersze
  według łańcucha i adresu. Tabela tylko do dopisywania (`olcys_app`: SELECT i INSERT).
- `clusters` (migracja `0007_address_clusters.sql`) — klastry Bitcoin z heurystyki wspólnego wydatkowania w tabeli
  `address_cluster` (`PRIMARY KEY (run_id, id)`; `id` = `c_` + skrót posortowanej listy adresów): ziarna i adresy
  (`text[]`), rozmiar i poprzedni rozmiar, dowody połączeń, pominięte transakcje, usługi i flagi (`jsonb`).
  `add(runId, klastry)` odrzuca powtórzony identyfikator, `list(runId)` zwraca wiersze według identyfikatora,
  `previousSizes(caseId, ziarna, beforeRunId)` — rozmiary klastrów ziaren z najnowszego wcześniejszego przebiegu sprawy
  (współczynnik wzrostu reguły A7). Tabela tylko do dopisywania (`olcys_app`: SELECT i INSERT).
- `chain.queryFlowEdges` i `queryFlowEdges(db, zapytanie)` (migracja `0008_fund_flows.sql`) — przepływy środków po
  zapisanych transferach przebiegu: przeszukiwanie wszerz na poziomie adresów (`walkFlows` z `@olcys/core`) z jednym
  parametryzowanym zapytaniem SQL na skok (surowy SQL przez `sql` Kysely). Jeden wpis na adres i skok (najwcześniejszy
  moment dotarcia) utrzymuje liniowy koszt; transfer występuje raz, w pierwszym skoku. Ścieżki kończą się na adresach
  z `stopAt` (usługi z etykietą, adresy wykluczone), krawędź do adresu już odwiedzonego ma `isCycle`; głębokość
  (`maxHops`) i liczba krawędzi (`limit`, wynik ma `truncated`) są ograniczone. Magazyn w pamięci używa tego samego
  przeszukiwania (`traceFlows`); oba są testowane na tych samych scenariuszach (`test/flow-cte.test.ts`).
  `addTransfers(..., { expansionHop })` zapisuje także historie kontrahentów pobrane w rozszerzeniu (kolumna
  `chain_transfers.expansion_hop`); `listTransfers` zwraca tylko historie adresów analizowanych.
- `analysis.addFlows` / `listFlows` (tabela `flow_edge`) i `addFlowViews` / `listFlowViews` (tabela `fund_flow_view`:
  oś czasu i agregat Sankey adresu) — wyniki obliczeń, tylko do dopisywania (`olcys_app`: SELECT i INSERT); krawędź
  tego samego transferu i skoku jest w przebiegu zapisana raz.
- `llm` (migracja `0010_llm.sql`) — wywołania modelu AI (`llm_call`: zadanie, wersja i skrót promptu, adres bazowy,
  model żądany i zgłoszony, skrót modelu, parametry, skrót i blob żądania, blob odpowiedzi, wynik, wynik wywołania,
  opóźnienie), sugestie (`llm_suggestion`) i decyzje analityka (`llm_suggestion_decision`, jedna na sugestię:
  `UNIQUE (suggestion_id)`). Status sugestii wynika z decyzji (brak decyzji = `pending`), więc nic nie jest
  aktualizowane; `decide` zwraca `false`, gdy decyzja już istnieje. Trzy tabele są tylko do dopisywania (`olcys_app`:
  SELECT i INSERT) i nie wpływają na żadną wartość oceny.
- `migrate(ownerUrl)` / `pnpm db:migrate` — migracje SQL z `migrations/` (z kontrolą skrótów SHA-256). Historię
  migracji (`schema_migrations`) może zapisywać wyłącznie właściciel schematu — `migrate()` odbiera prawa zapisu
  pozostałym rolom. Równoczesne uruchomienia (np. równoległe pliki testów) czekają na blokadę doradczą, więc każda
  migracja jest stosowana raz.
- Testy integracyjne wymagają `OLCYS_TEST_DATABASE_URL` i `OLCYS_TEST_DATABASE_URL_OWNER`.
