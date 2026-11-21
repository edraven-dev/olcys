# OŁCyŚ — Osintowy łapacz cyfrowych śladów

> Narzędzie OSINT dla analityków KAS, które łączy publicznie widoczne ślady w sieci (profile na forach, wpisy,
> ogłoszenia, protokoły tożsamości) z adresami kryptowalutowymi, ocenia każde powiązanie wyjaśnialnym
> **Wskaźnikiem Pewności**, odrzuca adresy giełd, portfeli powierniczych i smart kontraktów, wykrywa przesłanki
> **wyjścia z rynku krypto do walut tradycyjnych (fiat cash-out)**, cyklicznie powtarza analizy i porównuje ich wyniki
> oraz tworzy raport o wartości dowodowej. HackNation 2026 — wyzwanie KAS.

**Status:** szkielet projektu. Sekcje oznaczone _TODO_ zostaną uzupełnione wraz z implementacją (finalne README,
zrzuty ekranu i logi). Zasady pracy nad kodem: [`AGENTS.md`](AGENTS.md).

## Opis projektu

_TODO: problem (nieujawniane przychody z kryptowalut w PIT-38), sposób, w jaki OŁCyŚ „łączy kropki”
między śladami Web2 a aktywnością Web3, oraz to, co otrzymuje analityk._

## Założenia

- Wyłącznie publicznie dostępne, legalne źródła (OSINT): bez naruszania regulaminów, bez logowania na cudze konta,
  bez wycieków danych i bez obchodzenia zabezpieczeń. Rejestr źródeł ze statusem zgodności:
  [`config/sources.yaml`](config/sources.yaml), podsumowanie: [`docs/compliance/sources.md`](docs/compliance/sources.md).
- Demonstracja i testy korzystają **wyłącznie z danych syntetycznych** (strona testowa z fikcyjną personą;
  portfele demonstracyjne wyłącznie w lokalnych sieciach testowych — bez transakcji w publicznych sieciach).
- Dane, wyniki ani telemetria nie opuszczają systemu poza zatwierdzonymi, rejestrowanymi zapytaniami; model AI działa
  lokalnie za API zgodnym z OpenAI i można go wymienić samą konfiguracją.
- Wskaźnik opisuje powiązanie, a nie osobę; każdy wynik pokazuje źródła i przesłanki; fakty źródłowe, wyniki obliczeń
  i wnioski wymagające weryfikacji są rozdzielone.

## Architektura

Zob. [`docs/architecture.md`](docs/architecture.md) oraz [`docs/adr/0001-technology-stack.md`](docs/adr/0001-technology-stack.md).
TypeScript na Node.js 26 (API, procesy w tle, interfejs React w języku polskim), PostgreSQL 19, pg-boss, Gotenberg,
niewielki serwis w Pythonie (Maigret, socid-extractor, pyHanko), opcjonalny lokalny model językowy (Ollama).

## Parametry wyszukiwania

_TODO: identyfikatory wejściowe, źródła dla każdego typu identyfikatora, głębokość rozwijania wyszukiwania,
limity zapytań, obsługiwane sieci blockchain, okna czasowe, wagi i progi Wskaźnika Pewności oraz sposób
interpretacji wyników._

## Wymagania i instalacja

- Node.js ≥ 26.13.1, pnpm 12, Docker lub Podman z Compose.

```bash
cp .env.example .env
pnpm install
pnpm dev:deps        # PostgreSQL 19, Gotenberg 9, strona testowa
pnpm dev             # API :4000, interfejs :5173, worker, strona testowa :4100
pnpm check           # formatowanie, lint, kontrola typów, testy
```

Usługi opcjonalne: `docker compose --profile osint --profile llm up -d --wait`.

## Przykłady

_TODO: zrzuty ekranu i logi pełnej analizy syntetycznej persony._

## Licencje komponentów

[`docs/compliance/licenses.md`](docs/compliance/licenses.md)

## Licencja

_TODO: licencja projektu._
