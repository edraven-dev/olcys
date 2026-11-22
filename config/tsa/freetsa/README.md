# Kotwice zaufania FreeTSA (RFC 3161)

Publiczne certyfikaty usługi znakowania czasem [FreeTSA](https://freetsa.org/). Służą do weryfikacji tokenów
RFC 3161 pobieranych dla skrótów manifestów zbiorów dowodowych. To usługa demonstracyjna, bez gwarancji dostępności i
bez uznania prawnego; w produkcji używa się kwalifikowanego polskiego dostawcy usługi znakowania czasem (własny wpis w
`config/sources.yaml`, własne kotwice, `TSA_QUALIFIED=true`).

| Plik         | Rola                                  | Źródło                               | Ważny do   | SHA-256 (odcisk)                                                                                  |
| ------------ | ------------------------------------- | ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `cacert.pem` | główny urząd certyfikacji (kotwica)   | https://freetsa.org/files/cacert.pem | 2041-03-07 | `A6:37:9E:7C:EC:C0:5F:AA:3C:BF:07:60:13:D7:45:E3:27:BB:BA:A3:8C:0B:9A:F2:24:69:D4:70:1D:18:AA:BC` |
| `tsa.crt`    | certyfikat podpisujący odpowiedzi TSA | https://freetsa.org/files/tsa.crt    | 2040-02-02 | `32:E8:41:A9:5C:C1:16:41:01:FF:DE:41:29:8E:F2:FC:75:C1:C4:37:2E:F0:95:E8:8A:6B:BD:47:DF:B1:91:FC` |

Data pobrania: 2026-11-22. Pliki pobrano jednorazowo ręcznie, a odciski sprawdzono poza systemem; kod nigdy nie
pobiera ani nie odświeża tych plików. Test (`packages/evidence/test/tsa-anchors.test.ts`) porównuje odciski
zatwierdzonych plików z tabelą powyżej. Są to certyfikaty publiczne: klucze prywatne nie są przechowywane w
repozytorium ani nigdzie indziej.

## Użycie

- `TSA_TRUST_ANCHORS=config/tsa/freetsa/cacert.pem` — kotwice, do których musi prowadzić łańcuch certyfikatu podpisującego.
  Certyfikat TSA dołączany jest do odpowiedzi (`certReq`), więc plik `tsa.crt` nie jest potrzebny kodowi; służy do
  weryfikacji niezależnej (poniżej).
- Po zmianie certyfikatu TSA przez usługodawcę (poprzednia zmiana: 2026-03-16) należy ręcznie pobrać nowy plik,
  sprawdzić odcisk poza systemem i dopisać kotwicę (starą zachować, aby weryfikować wcześniejsze tokeny).

## Niezależna weryfikacja tokenu

Odpowiedź TSA (`TimeStampResp`, DER) jest zapisywana w magazynie blobów (`application/timestamp-reply`). Po zapisaniu
jej do pliku `odpowiedz.tsr` skrót manifestu zbioru (`manifestSha256`, 64 znaki szesnastkowe) można zweryfikować bez
udziału OŁCyŚ:

```bash
openssl ts -verify -digest <manifestSha256> -in odpowiedz.tsr -CAfile cacert.pem -untrusted tsa.crt
```

Polecenie kończy się komunikatem `Verification: OK`.
