import { beforeAll, describe, expect, it } from 'vitest';
import { loadMaskSource, maskedParts, type MaskSource } from './mask.ts';

let source: MaskSource;
beforeAll(async () => {
  source = await loadMaskSource();
});
const masked = (text: string) => maskedParts(text, source);

describe('presentation masking', () => {
  it('masks the persona identifiers, case-insensitively', () => {
    expect(masked('Kacper Fikcyjny (demonstracja)')).toEqual(['Kacper Fikcyjny']);
    expect(masked('nick: FIKCYJNY_KACPER na bitcointalk')).toEqual(['FIKCYJNY_KACPER']);
    expect(masked('github: fikcyjny-kacper')).toEqual(['fikcyjny-kacper']);
    expect(masked('kontakt: kacper.fikcyjny@example.org')).toEqual(['kacper.fikcyjny@example.org']);
    expect(masked('bitcointalk:900001')).toEqual(['900001']);
  });

  it('masks any e-mail address and profile URLs that carry a persona value', () => {
    expect(masked('jan.kowalski@firma.example')).toEqual(['jan.kowalski@firma.example']);
    const url = 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;user=fikcyjny_kacper';
    expect(masked(`Źródło: ${url} ok`)).toEqual([url]);
  });

  it('masks addresses and hashes of every supported format', () => {
    const samples = [
      'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2', // bech32
      'bc1qsyrа8u0s8akk2qyh7kkqcfgrexw85n5aqmnhdv', // with a Cyrillic homoglyph
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', // base58 legacy
      '0xc3436335b60f0fd74bf6c2638f7a8fa64ac53cd7', // EVM
      'TMVZLbhMuEYfsXYUzwWSarLmLPWJUmVPVk', // TRON
      '0x49032b0b289a725fdf2b0d82ff1384f2366fe4792f18932b55ec828f24014700', // tx hash
      'a2c3225fd8e7b1f9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3', // bare 64 hex
      '0xcd5c1a91…5a54617a', // shortened by the console
      'bc1qqeyyk5…h67m9mt2',
      'kacper.fik…mple.org', // shortened e-mail
      'jan.kowal…irma.pl',
      'TMVZLbhMuE…WJUmVPVk',
      '61109010140000071219812874', // NRB bank account (26 digits)
      'PL61 1090 1014 0000 0712 1981 2874', // IBAN, grouped
      '25000000000000000010001', // long synthetic registry account number
    ];
    for (const sample of samples) expect(masked(`adres ${sample} koniec`)).toEqual([sample]);
  });

  it('leaves scores, bands, rule codes, amounts, dates, labels and slot names alone', () => {
    const visible = [
      'Wskaźnik Pewności 99/100 — niemal pewne',
      'A4: Adres depozytowy giełdy, A1, A2, A8',
      'B1: Wpłata na giełdę — 22 558,85 zł',
      'kurs średni NBP, tabela SYN456/A/NBP/2026 z dnia 2026-11-02: 1 USD = 3,8074 zł',
      '22.11.2026, 05:21:12',
      'κ (dopasowanie przekazania depozytu) 0,96',
      'weights.v2 · exclusion.v1 · cashout.v1',
      'DANE SYNTETYCZNE — demonstracja',
      'BTC-1 → BTC-2, TRON-1, ETH-1',
      'Powiązane adresy 57, odrzucone 4',
      'fixtures/l…ted.json, http://127…65000101',
    ];
    for (const text of visible) expect(masked(text)).toEqual([]);
  });
});
