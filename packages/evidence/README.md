# @olcys/evidence

Magazyn plików adresowany treścią (SHA-256), manifesty, rekordy zabezpieczeń stron zgodne z Protokołem Berkeley, znaczniki czasu RFC 3161 oraz porównywanie kolejnych przebiegów analizy.

- **Zależności:** wyłącznie kontrakty `@olcys/core`. Inne pakiety są dostępne przez porty łączone w `apps/worker`.
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/evidence`.

## Publiczne API

- `FileBlobStore(root)` — niezmienny magazyn plików adresowany SHA-256 (zapis atomowy, weryfikacja przy odczycie).
- `InMemoryBlobStore` — implementacja do testów; `sha256Hex()`; `canonicalJson()` (RFC 8785, z `@olcys/core`).
- `buildPropertyTimelines(wejście, filtr?)` — oś czasu wartości strony (`page.address`: adresy wyodrębnione ze strony)
  i pól profilu: punkty z kopii archiwalnych (Wayback Machine, czas migawki podany przez archiwum, nigdy czas naszego
  pobrania) i z przebiegów na żywo, okresy o tym samym zbiorze wartości oraz zmiany z przedziałem czasu (ostatni punkt
  przed zmianą — pierwszy po). Wartości pochodzą z wyników wyodrębnienia (`extractions`; `latestExtractions()` wybiera dla przechwycenia wynik najnowszej analizy, więc ponowna ocena z odrzuconym adresem usuwa go z osi); przechwycenie bez wyniku wyodrębnienia to luka `extraction_pending`, a nie usunięcie adresu. Przechwycenie, które odczytało profil konta (`profileCaptureId`), reprezentuje kanoniczną stronę
  profilu tego konta (np. profil pobrany po nicku to strona `…;u=<id>` z wykazu archiwum), niezależnie od adresu żądania. Niepobrana kopia z tym samym skrótem CDX dziedziczy wartości (`inferredFromDigest`,
  data przybliżona); niepobrana kopia z nowym skrótem, skrót niezgodny, strona zablokowana, za logowaniem, z CAPTCHA,
  z błędem lub 404 to luka — nigdy nie kończy okresu i nie tworzy zmiany. Funkcja jest czysta (bez sieci i bez dostępu
  do bazy); pomocnicze: `normalisePageUrl()` (http/https jednakowo, mała litera hosta, bez portu domyślnego, fragmentu
  i końcowego ukośnika) oraz `snapshotTimestampToIso()` (14-cyfrowy znacznik Wayback → UTC ISO; nieprawidłowy →
  `undefined`, wiersz jest pomijany z ostrzeżeniem).
- `diffRuns(before, after)` — porównanie dwóch przebiegów: fakty porównywane według `(platforma, lokalizator,
  właściwość)` dają zdarzenia `ADDED`, `REMOVED` i `VALUE_CHANGED`; zmiana właściwości z adresem portfela ma znacznik
  `wallet` (alert podmiany portfela). Fakt nieobecny na stronie zablokowanej, za logowaniem, za CAPTCHA, z błędem lub
  niepobranej jest wstrzymywany (`suppressed`), a nie zgłaszany jako usunięty. Zmiana wyniku powiązania daje
  `SCORE_CHANGED` z przyczyną: dane, algorytm lub oba. Każde zdarzenie ma skrót `keySha256` do idempotentnego zapisu.

## Przechwycenia zgodne z Protokołem Berkeley

- `createCaptureRecorder({ clockSync, collector, toolVersion, gitCommit? })` — `CaptureRecorder`, jedyne miejsce, które
  buduje manifest. `record(draft, ctx)` zapisuje artefakty (`{ bytes, mediaType }`) albo ponownie liczy skrót plików już
  zapisanych przez klienta egress (`{ blob }`; niezgodność lub brak pliku to `ArtifactIntegrityError` i nic nie jest
  zapisywane), buduje manifest w kanonicznym JSON (RFC 8785; artefakty sortowane po rodzaju i skrócie, narzędzia po nazwie),
  zapisuje go w magazynie jako `application/vnd.olcys.capture-manifest+json` i zwraca `Capture`, którego
  `manifestSha256` jest skrótem tego pliku. Tożsamość kolektora, zegar i wersję narzędzia ustawia rejestrator — wartości
  podane przez kolektor są ignorowane. Ostrzeżenie o brakujących artefaktach (np. zrzut ekranu — przeglądarka nie jest
  włączona) trafia do dziennika raz na przebieg.
- `requiredArtifacts(profil)` — wymagane rodzaje artefaktów: `web_page` → `html`, `screenshot`; `api_response` →
  `headers` + `json`/`html`/`text`; `archive_snapshot` → `html`.
- `resolveCollectorIdentity(env, os)` — nazwa (`OLCYS_COLLECTOR_NAME`), host, adres IP (`OLCYS_COLLECTOR_IP`, inaczej pierwszy
  zewnętrzny IPv4 interfejsu, inaczej brak); bez zapytań sieciowych.
- `createClockSyncCheck({ clock, exec?, exists?, maxOffsetMs?, cacheMs? })` — lokalne sondy `chronyc`, `timedatectl`, plik
  `timesyncd`; limit 2 s, bez powłoki, pamięć podręczna 60 s; `injectedClockSync()` do testów.
- `verifyCapture(skrótManifestu, magazyn)` — sprawdza, czy manifest ma poprawny skrót i schemat oraz czy każdy wymieniony
  artefakt istnieje i ma zapisany skrót (`ok` / `missing` / `digest_mismatch`).
- `writeCollectionPackage(skróty, katalog, magazyn)` — paczka zabezpieczonego materiału: `manifests/<id>.json`,
  `artifacts/<id>/<rodzaj>-<12 znaków skrótu>.<rozszerzenie>`, posortowany `SHA256SUMS` i `CZYTAJ_MNIE.txt`. Katalog docelowy musi być pusty albo nieistniejący
  (`OutputDirectoryNotEmptyError`; CLI kończy się kodem 1), aby paczki nie mieszały się ze sobą.
- `custodyCollected(capture, actor)` — zdarzenie łańcucha dowodowego `collected` (zapis w `custody_event`).

### Procedura weryfikacji

Polecenia działają na magazynie z `OLCYS_DATA_DIR` (domyślnie `./data`), bez dostępu do sieci i bazy danych:

```bash
node packages/evidence/src/cli.ts verify <skrót-manifestu>            # kod wyjścia 1, gdy cokolwiek jest niezgodne
node packages/evidence/src/cli.ts export <katalog> <skrót-manifestu>…  # paczka z SHA256SUMS i CZYTAJ_MNIE.txt
cd <katalog> && sha256sum -c SHA256SUMS                               # niezależna kontrola paczki
```

Skrót manifestu to `Capture.manifestSha256` (aneks dowodowy raportu). Skrót potwierdza, że plik jest taki sam jak w chwili
zabezpieczenia; nie dowodzi prawdziwości treści strony.

### Zegar w kontenerze

Kontener zwykle nie ma `chronyc` ani `timedatectl`, więc zegar jest raportowany jako `unknown` (`clockSynced: false`).
Stan zegara hosta można udostępnić, montując plik `/run/systemd/timesync/synchronized` (tylko do odczytu) albo
uruchamiając proces na hoście z działającym `chronyd`/`systemd-timesyncd`.
