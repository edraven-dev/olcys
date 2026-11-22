# Prezentacja dla jury

Materiały na zgłoszenie hackathonowe. Wszystkie dane i zrzuty ekranu są syntetyczne (niemaskowane).

- `slajdy.html`: źródło prezentacji (10 slajdów 16:9, HTML i CSS, czcionki systemowe, bez skryptów i zdalnych zasobów); zrzuty ekranu są wczytywane z `../assets/screenshots/`.
- `olcys-prezentacja.pdf`: prezentacja wygenerowana ze źródła.
- `notatki-prelegenta.md`: notatki prelegenta do każdego slajdu.
- `scenariusz-wideo.md`: scenariusz filmu `olcys-demo.mp4` (katalog główny repozytorium, do 3 minut).

## Ponowne generowanie PDF

```bash
cd docs/presentation
chromium --headless=new --no-pdf-header-footer --print-to-pdf="$PWD/olcys-prezentacja.pdf" \
  --virtual-time-budget=10000 "file://$PWD/slajdy.html"
pdfinfo olcys-prezentacja.pdf   # oczekiwane: Pages: 10, 1440 x 810 pts
```
