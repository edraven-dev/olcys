# olcys-osint (serwis w Pythonie)

Wewnętrzna usługa HTTP wywoływana wyłącznie przez `apps/worker`. Istnieje, ponieważ Maigret i socid-extractor (MIT)
są dostępne tylko w Pythonie i nie mają odpowiedników w innych językach, a pyHanko (MIT) służy do podpisywania raportów
PDF. To jedyne uzasadnienie użycia Pythona w repozytorium (zob. `docs/adr/0001-technology-stack.md`).

```bash
docker compose --profile osint up -d --build --wait
curl http://127.0.0.1:8090/healthz
```

- Python 3.15, zależności zarządzane przez [uv](https://github.com/astral-sh/uv). Plik blokady tworzy się poleceniem
  `docker run --rm -v "$PWD":/app -w /app ghcr.io/astral-sh/uv:0.13.9 lock` (lokalna instalacja uv nie jest potrzebna).
- Podpisywanie PDF działa dwufazowo (`/v1/pdf/sign/prepare`, `/v1/pdf/sign/finish`); zapytanie do serwera znaczników
  czasu wykonuje worker w Node przez klienta ruchu wychodzącego, więc ten serwis nie łączy się z nim sam.
- Zasady: przypięta baza serwisów Maigret (bez automatycznych aktualizacji), lista dozwolonych tagów, bez proxy, bez
  omijania CAPTCHA, bez `--ai`, bez sondy GraphQL serwisu X/Twitter. Zewnętrzne serwisy wyłącznie przy
  `OLCYS_OSINT_ALLOW_EXTERNAL=true`.
