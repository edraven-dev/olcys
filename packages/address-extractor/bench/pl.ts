/**
 * Polish catalogue of the extraction benchmark: every user-visible string of `report.md` and of the gate labels.
 * Code, identifiers and logs stay English.
 */

export const OBFUSCATION_PL: Readonly<Record<string, string>> = {
  none: 'bez zaciemnień',
  spaces4: 'spacje co 4 znaki',
  newline: 'podział wierszami (fragmenty ≤ 16 znaków)',
  zero_width: 'znaki zerowej szerokości',
  bidi: 'znaki sterujące kierunkiem tekstu',
  homoglyph: 'homoglify (wabiki — oczekiwane odrzucenie)',
  fullwidth: 'znaki pełnej szerokości',
  span_split: 'podział na elementy `<span>`',
  br_split: 'podział znacznikami `<br>`',
  td_split: 'podział na komórki tabeli',
  defang: '„rozbrojony” odnośnik (`hxxps`, `[.]`)',
  entities: 'encje HTML',
  percent: 'kodowanie procentowe w URI',
  attr_only: 'wyłącznie w atrybucie HTML',
  json_ld_only: 'wyłącznie w JSON / JSON-LD',
  qr: 'kod QR',
  ocr: 'OCR',
};

export const CHANNEL_PL: Readonly<Record<string, string>> = {
  text: 'tekst',
  attr: 'atrybut HTML',
  uri: 'URI płatności',
  explorer: 'odnośnik do eksploratora',
  json_ld: 'JSON / JSON-LD',
  qr: 'kod QR',
  ocr: 'OCR',
};

export const CHAIN_PL: Readonly<Record<string, string>> = { bitcoin: 'Bitcoin', evm: 'EVM', tron: 'TRON' };

export const ROLE_PL: Readonly<Record<string, string>> = {
  first_person_owner: 'właściciel (1. osoba)',
  payment_request: 'prośba o płatność',
  donation: 'darowizna',
  scam_report: 'zgłoszenie oszustwa',
  warning: 'ostrzeżenie',
  quote: 'cytat',
  exchange_deposit: 'depozyt giełdowy',
  listing: 'lista / przykład',
  unclear: 'brak wskazówki',
};

export const ATTRIBUTION_PL: Readonly<Record<string, string>> = {
  all: 'wszystkie trafione wystąpienia',
  bitcoin: 'Bitcoin (wszystkie formaty)',
  evm: 'EVM — identyfikator sieci',
  tron: 'TRON',
  base58_1_3: 'adresy `1…`/`3…` (BTC, LTC, BCH)',
  p2sh_3: 'adresy `3…`',
  marker_uri: 'z URI płatności',
  marker_explorer: 'z odnośnika do eksploratora',
};

export const NEGATIVE_PL: Readonly<Record<string, string>> = {
  corrupt1: '1 podmieniony znak',
  corrupt2: '2 podmienione znaki',
  transpose: 'zamiana sąsiednich znaków',
  truncate: 'obcięty adres',
  eip55_case_flip: 'EIP-55 ze zmienioną wielkością liter',
  bech32_mixed_case: 'bech32 z mieszaną wielkością liter',
  v1_in_bech32: 'wersja 1 zakodowana w bech32',
  v0_in_bech32m: 'wersja 0 zakodowana w bech32m',
  testnet_bech32: 'testnet bech32 (`tb1…`)',
  testnet_base58: 'testnet base58 (`m…`, `n…`, `2…`)',
  homoglyph: 'homoglif (cyrylica)',
  uri_token_contract: 'kontrakt tokena w URI EIP-681',
  tx_hash: 'skrót transakcji `0x` + 64 hex',
  txid_hex64: 'identyfikator transakcji (64 hex)',
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  git_sha: 'skrót commita git',
  uuid: 'UUID',
  ipfs_cid_v0: 'IPFS CIDv0 (`Qm…`)',
  ipfs_cid_v1: 'IPFS CIDv1 (`bafy…`)',
  jwt_like: 'ciąg w kształcie JWT',
  token_generic: 'ciąg `token_…`',
  base58_random: 'losowy base58 (32–44 znaki)',
  base64url_48: 'losowy base64url (48 znaków)',
  email: 'adres e-mail',
  eth_filename: 'nazwa pliku z `.eth`',
  example: 'wektor z dokumentacji (BIP, EIP, Bitcoin Wiki)',
  evm_single_case_corruption: 'EVM jednej wielkości liter z podmienionym znakiem',
  split_unchecksummed: 'EVM bez sumy kontrolnej podzielony na grupy',
  hex40_prefixed: '`0x` + 40 hex, które nie jest adresem',
};

/** Chain families the extractor does not support yet (the manifest data itself is English). */
export const UNSUPPORTED_PL: Readonly<Record<string, string>> = {
  litecoin: '`L…`, `M…`, `ltc1…` (stare adresy `3…` mierzone razem z Bitcoin `p2sh`)',
  dogecoin: '`D…`, `A…`, `9…`',
  bitcoincash: 'CashAddr z prefiksem i bez (stare adresy `1…`/`3…` mierzone razem z Bitcoin)',
  xrp: 'klasyczne `r…`, X-address',
  solana: 'klucze publiczne base58 na krzywej i poza nią',
  monero: 'standardowe, podadresy, zintegrowane',
  cardano: 'Shelley `addr1…`, Byron',
  ton: '`EQ…`/`UQ…` (przyjazne), surowe `0:…`',
  lightning: 'BOLT11, LNURL, LUD-16',
  xpub: '`xpub`, `ypub`, `zpub`',
};

export const EXPECTATION_PL: Readonly<Record<string, string>> = {
  reject: 'odrzucenie',
  testnet: 'odrzucenie (testnet)',
  example: 'odrzucenie (lista wykluczeń)',
  unverifiable: 'niesprawdzalne',
};

const chain = (family: string): string => CHAIN_PL[family] ?? family;

/** Gate labels (`GateResult.label`). */
export const GATE_PL = {
  cleanRecall: (family: string): string => `${chain(family)}: czułość, czyste formaty z sumą kontrolną`,
  cleanPrecision: (family: string): string => `${chain(family)}: precyzja, czyste formaty z sumą kontrolną`,
  obfuscatedRecall: 'Czułość na zaciemnionych wystąpieniach',
  corroboratedPrecision: 'Precyzja formatów bez sumy kontrolnej potwierdzonych URI, eksploratorem lub słowem kluczowym',
  secretRecall: 'Czułość maskowania sekretów',
  secretLeaks: 'Wycieki fragmentów sekretów (wyniki, logi i raport)',
  secretTotal: 'Liczba sekretów w korpusie',
  secretKinds: 'Liczba rodzajów sekretów',
  hashLike: 'Kandydaci ze skrótów transakcji, CID IPFS, skrótów MD5/SHA/git, ciągów JWT i tokenów',
  variantMismatch: 'Wektory v1 w bech32 i v0 w bech32m odrzucone jako bech32_variant_mismatch',
  spiderfoot: 'SpiderFoot: precyzja na dokumentach z trudnymi negatywami niższa niż OŁCyŚ',
  missing: (what: string): string => `brak danych w korpusie: ${what}`,
} as const;

/** Headings, table headers and sentences of `report.md`. */
export const REPORT_PL = {
  title: '# Benchmark wyodrębniania adresów — raport',
  corpus: (version: string, seed: string, extractor: string): string =>
    `- Korpus: wersja ${version}, ziarno \`${seed}\`; ekstraktor \`${extractor}\`.`,
  generatedAt: (at: string): string => `- Wygenerowano: ${at}.`,
  documents: (
    docs: string,
    mb: string,
    rows: string,
    positives: string,
    negatives: string,
    unverifiable: string,
    secrets: string,
  ): string =>
    `- Dokumenty: ${docs} (${mb} MB), oznaczone wystąpienia: ${rows} — pozytywne ${positives}, trudne negatywy ${negatives}, niesprawdzalne ${unverifiable}, sekrety ${secrets}.`,
  templates: (list: string): string => `- Szablony: ${list}.`,
  matching:
    '- Dopasowanie: na poziomie adresów w obrębie dokumentu (sieć z listy sieci, na których bajty są poprawne) oraz na poziomie wystąpień (zakres w źródle dokumentu, tolerancja ±2 znaki). Przedziały ufności: bootstrap po dokumentach, 1000 prób, stałe ziarno; próby, w których wskaźnik jest nieokreślony, są pomijane.',
  summary: '## Podsumowanie',
  summaryHeader: ['| Narzędzie | Zakres | Precyzja | Czułość | F1 |', '| --- | --- | --: | --: | --: |'],
  ours: 'OŁCyŚ',
  spiderfoot: 'SpiderFoot (wyrażenia regularne)',
  scopeAll: 'Bitcoin, EVM, TRON',
  scopeComparison: 'Bitcoin, EVM (porównanie)',
  scopeHardNegatives: 'dokumenty z trudnymi negatywami',
  gates: '## Progi (bramka CI)',
  gatesHeader: ['| Próg | Wartość | Wymaganie | Wynik | Szczegóły |', '| --- | --: | --- | --- | --- |'],
  gatePassed: 'spełniony',
  gateFailed: '**NIE SPEŁNIONY**',
  byChain: '## Według sieci (poziom adresów)',
  allChains: 'wszystkie',
  bySubtype: '## Według podtypu (poziom adresów)',
  byObfuscation: '## Według zaciemnienia (poziom wystąpień)',
  byChannel: '## Według kanału (poziom wystąpień)',
  metricHeader: [
    '| Wycinek | TP | FP | FN | Precyzja (95 % CI) | Czułość (95 % CI) | F1 |',
    '| --- | --: | --: | --: | --- | --- | --: |',
  ],
  notRun: 'nie uruchomiono (`not_run`)',
  gateGroups: '## Grupy progów',
  cleanGroup: (family: string): string => `${chain(family)}: czyste formaty z sumą kontrolną`,
  obfuscatedGroup: 'zaciemnione wystąpienia',
  corroboratedGroup: 'bez sumy kontrolnej, z potwierdzeniem (URI, eksplorator, słowo kluczowe)',
  attribution: '## Przypisanie sieci',
  attributionHeader: ['| Wycinek | Poprawne | Wszystkie | Trafność |', '| --- | --: | --: | --: |'],
  roles: (macroF1: string): string => `## Wskazówki ról (pierwsza wskazówka; macro-F1 ${macroF1})`,
  rolesHeader: ['| Rola | TP | FP | FN | Precyzja | Czułość | F1 |', '| --- | --: | --: | --: | --: | --: | --: |'],
  secrets: '## Sekrety (maskowanie)',
  secretsLine: (recall: string, redacted: string, total: string, leaks: string): string =>
    `Czułość ${recall} (${redacted}/${total}), wycieki fragmentów (12 znaków) w wynikach i logach: ${leaks}. Sekrety istnieją wyłącznie w pamięci podczas pomiaru; sekret jest zamaskowany, gdy wynik pokrywa każdy znak klucza.`,
  secretsHeader: ['| Rodzaj | Liczba | Zamaskowane |', '| --- | --: | --: |'],
  negatives: '## Trudne negatywy',
  negativesHeader: [
    '| Rodzaj | Oczekiwanie | Liczba | Przyjęte przez OŁCyŚ | Odrzucone z oczekiwanym kodem | Przyjęte przez SpiderFoot |',
    '| --- | --- | --: | --: | --: | --: |',
  ],
  negativesNote:
    'Wartości „niesprawdzalne” są poprawnymi adresami pod względem formatu (brak sumy kontrolnej), więc ich wyodrębnienie nie jest liczone jako fałszywy alarm; kody odrzuceń sprawdzane są na liście odrzuceń ekstraktora.',
  comparison: '## Porównanie z SpiderFoot',
  comparisonLine: (version: string): string =>
    `SpiderFoot (\`${version}\`) wykrywa wyłącznie Bitcoin i Ethereum; uruchomiono jego wyrażenia regularne na surowym tekście dokumentu (tak jak na pobranej treści strony).`,
  oursComparison: 'OŁCyŚ — Bitcoin i EVM',
  spiderfootComparison: 'SpiderFoot — Bitcoin i EVM',
  oursHardNegatives: (documents: string): string => `OŁCyŚ — dokumenty z trudnymi negatywami (${documents})`,
  spiderfootHardNegatives: 'SpiderFoot — dokumenty z trudnymi negatywami',
  spiderfootChain: (family: string): string => `SpiderFoot — ${chain(family)}`,
  iocsearcher: (run: boolean): string =>
    `iocsearcher: ${run ? 'wyniki w report.json' : 'nie uruchomiono (`not_run`)'}.`,
  notRunChannels: '## Nieuruchomione kanały',
  imageChannels:
    '- Kody QR i OCR (`qr`, `ocr`): `not_run` — korpus nie zawiera jeszcze obrazów, a ekstraktor nie ma kanału obrazów.',
  unsupported: '## Sieci nieobsługiwane — nie mierzono',
  unsupportedHeader: ['| Rodzina | Formaty | Planowana liczba przykładów |', '| --- | --- | --: |'],
  throughput: '## Przepustowość',
  throughputLine: (docs: string, mb: string): string =>
    `${docs} dokumentów/s, ${mb} MB/s (sam \`extractCapture\`, jeden wątek).`,
  failures: '## Błędy',
  falseNegatives: (n: string, examples: string): string => `- Pominięte wystąpienia (FN): ${n}${examples}.`,
  falsePositives: (n: string, examples: string): string => `- Fałszywe alarmy (FP): ${n}${examples}.`,
  attributionErrors: (n: string, examples: string): string => `- Błędy przypisania sieci: ${n}${examples}.`,
  attributionExample: (where: string, expected: string, actual: string, method: string): string =>
    `${where} oczekiwano \`${expected}\`, jest \`${actual}\` (${method})`,
  examples: (list: string): string => ` — np. ${list}`,
  gateFailures: (list: string): string => `- Niespełnione progi: ${list}.`,
  none: 'brak',
} as const;
