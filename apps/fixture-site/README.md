# @olcys/fixture-site — syntetyczna strona testowa

Strona z fikcyjną personą „Kacper Fikcyjny” (`fikcyjny_kacper`) do demonstracji i testów. Odwzorowuje strukturę forum
(SMF), serwisu społecznościowego, ogłoszenia P2P, serwisu z kodem i kanału komunikatora, a także historie transakcji
w formatach Esplora, Etherscan V2 i TronGrid. Wszystkie dane są syntetyczne: każda odpowiedź ma nagłówek
`x-olcys-synthetic: true`, a każda strona — baner „DANE SYNTETYCZNE” i `noindex`.

## Uruchomienie

- W kontenerze: `pnpm dev:deps` (port 4100; `GET /healthz` zwraca `ok v1`).
- Na hoście: `pnpm dev:fixture` (najpierw zatrzymaj kontener: `docker compose stop fixture-site`).
- Zmienne: `FIXTURE_HOST`, `FIXTURE_PORT`, `FIXTURE_VARIANT` (`v1` lub `v2`). `FIXTURE_ALLOW_VARIANT_SWITCH=1` włącza
  `POST /__fixture/variant` z treścią `v1` lub `v2` — przełączenie wariantu bez restartu (domyślnie wyłączone).

Serwer (`src/`) używa wyłącznie wbudowanych modułów Node, bo kontener nie ma `node_modules`.

## Warianty

- `v1`: profil forum podaje adres BTC-1.
- `v2`: profil podaje BTC-2 — demonstracja wykrycia zmiany (`VALUE_CHANGED`). Pozostałe strony są identyczne.

## Zawartość

| Ścieżka                                                                     | Zawartość                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/bitcointalk/index.php?action=profile;u=900001`                            | profil forum persony (pole „Bitcoin address”)                                                                                       |
| `/bitcointalk/index.php?topic=5500001.0`                                    | podpisana wiadomość BIP-137 dla BTC-1 i potwierdzenie innego użytkownika                                                            |
| `/bitcointalk/index.php?topic=5500002.0`                                    | wpłata na giełdę (ETH-1; hash transakcji jako wabik D1), lista portfeli giełd (D4), adres z dokumentacji (D2), adres kontraktu (D5) |
| `/wykop/ludzie/fikcyjny_kacper/`                                            | wpis z portfelem USDT TRC20 (TRON-1) i odnośnik do profilu forum                                                                    |
| `/tablica/ogloszenie/81000001/`                                             | ogłoszenie P2P: sprzedaż USDT za PLN (TRON-1, imię i nazwisko, e-mail)                                                              |
| `/github/fikcyjny-kacper/…`                                                 | konto z tym samym nickiem, niepowiązane z personą; `FUNDING.json` z ETH-2                                                           |
| `/telegram/s/olcys_test_ostrzezenia/`                                       | kanał z ostrzeżeniami: adres oszusta TRON-2 (atrybucja przez stronę trzecią) i adres z homoglifem (D3)                              |
| `/barriers/…`                                                               | CAPTCHA, logowanie, 403, 429, wyzwanie przeglądarki, przekierowania                                                                 |
| `/robots.txt`, `/private/`                                                  | test zgodności z robots.txt (kanarek BTC-CANARY)                                                                                    |
| `/chain/esplora/api/…`, `/chain/etherscan/v2/api?…`, `/chain/trongrid/v1/…` | syntetyczne historie transakcji, w tym depozyt giełdowy, przelewy P2P i kod kontraktu                                               |

Sondy typu adresu odpowiadają jak u prawdziwych dostawców: `eth_getStorageAt` zwraca słowo zerowe (brak singletonu
Safe i implementacji proxy), `eth_call` do CONTRACT-1 kończy się wycofaniem (`execution reverted` — zwykły kontrakt,
odrzucany regułą A2), do adresu bez kodu zwraca `0x`, a `/chain/trongrid/wallet/getcontract` odpowiada `{}` (konto TRON
bez kontraktu). Adresy EOA persony pozostają kontami zewnętrznymi.

Pełny opis — adresy, wabiki, oczekiwane wyniki analizy i skróty plików — zawiera `fixtures/persona/manifest.json`.

## Generator

- `pnpm --filter @olcys/fixture-site fixtures:generate` — nowe adresy i podpis, manifest, wektory testowe podpisów,
  etykiety demonstracyjne i render katalogu `public/`.
- `fixtures:render` — ponowny render z istniejącego manifestu (po zmianie szablonów w `templates/`).
- `fixtures:check` — sprawdza zgodność `public/` z manifestem; to samo sprawdzają testy.

Generator działa lokalnie, bez sieci. Klucz prywatny BTC-1 istnieje tylko w pamięci i jest zerowany po podpisaniu;
pozostałe adresy to losowe bajty w poprawnym formacie. Katalogi `templates/` i `public/` są wyłączone z formatowania,
bo ich treść to dane testowe.

## Testy

`pnpm vitest run --project @olcys/fixture-site`
