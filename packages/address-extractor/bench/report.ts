/**
 * Polish Markdown rendering of a `BenchReport` (`report.md`). Pure: numbers come from the report object only.
 */
import type { BenchReport, Metrics } from './types.ts';

const OBFUSCATION_PL: Record<string, string> = {
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

const CHANNEL_PL: Record<string, string> = {
  text: 'tekst',
  attr: 'atrybut HTML',
  uri: 'URI płatności',
  explorer: 'odnośnik do eksploratora',
  json_ld: 'JSON / JSON-LD',
  qr: 'kod QR',
  ocr: 'OCR',
};

const CHAIN_PL: Record<string, string> = { bitcoin: 'Bitcoin', evm: 'EVM', tron: 'TRON' };

const ROLE_PL: Record<string, string> = {
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

const ATTRIBUTION_PL: Record<string, string> = {
  all: 'wszystkie trafione wystąpienia',
  bitcoin: 'Bitcoin (wszystkie formaty)',
  evm: 'EVM — identyfikator sieci',
  tron: 'TRON',
  base58_1_3: 'adresy `1…`/`3…` (BTC, LTC, BCH)',
  p2sh_3: 'adresy `3…`',
  marker_uri: 'z URI płatności',
  marker_explorer: 'z odnośnika do eksploratora',
};

const NEGATIVE_PL: Record<string, string> = {
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

/** Polish descriptions of the chain families the extractor does not support yet (manifest data is English). */
const UNSUPPORTED_PL: Record<string, string> = {
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

const EXPECTATION_PL: Record<string, string> = {
  reject: 'odrzucenie',
  testnet: 'odrzucenie (testnet)',
  example: 'odrzucenie (lista wykluczeń)',
  unverifiable: 'niesprawdzalne',
};

export function pct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2).replace('.', ',')} %`;
}

function ci(range: readonly [number, number]): string {
  if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) return '—';
  return `${pct(range[0])} – ${pct(range[1])}`;
}

const int = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function metricRow(label: string, m: Metrics | 'not_run'): string {
  if (m === 'not_run') return `| ${label} | — | — | — | nie uruchomiono (\`not_run\`) | — | — |`;
  return `| ${label} | ${int(m.tp)} | ${int(m.fp)} | ${int(m.fn)} | ${pct(m.precision)} (${ci(m.precisionCi95)}) | ${pct(m.recall)} (${ci(m.recallCi95)}) | ${pct(m.f1)} |`;
}

const METRIC_HEADER = [
  '| Wycinek | TP | FP | FN | Precyzja (95 % CI) | Czułość (95 % CI) | F1 |',
  '| --- | --: | --: | --: | --- | --- | --: |',
];

function gateValue(value: number, metric: string): string {
  return metric === 'value' && Number.isInteger(value) ? int(value) : pct(value);
}

/** The headline table (copied into the methodology note). */
export function summaryTable(report: BenchReport): string[] {
  const rows: [string, string, Metrics | undefined][] = [
    ['OŁCyŚ', 'Bitcoin, EVM, TRON', report.overall],
    ['OŁCyŚ', 'Bitcoin, EVM (porównanie)', report.comparisonChains.ours],
    ['SpiderFoot (wyrażenia regularne)', 'Bitcoin, EVM (porównanie)', report.comparisonChains.spiderfoot],
    ['OŁCyŚ', 'dokumenty z trudnymi negatywami', report.hardNegativeDocuments.ours],
    ['SpiderFoot (wyrażenia regularne)', 'dokumenty z trudnymi negatywami', report.hardNegativeDocuments.spiderfoot],
  ];
  return [
    '| Narzędzie | Zakres | Precyzja | Czułość | F1 |',
    '| --- | --- | --: | --: | --: |',
    ...rows.map(
      ([tool, scope, m]) =>
        `| ${tool} | ${scope} | ${pct(m?.precision ?? Number.NaN)} | ${pct(m?.recall ?? Number.NaN)} | ${pct(m?.f1 ?? Number.NaN)} |`,
    ),
  ];
}

export function renderReportMarkdown(report: BenchReport): string {
  const out: string[] = [];
  const c = report.corpus;
  out.push(
    '# Benchmark wyodrębniania adresów — raport',
    '',
    `- Korpus: wersja ${report.corpusVersion}, ziarno \`${c.seed}\`; ekstraktor \`${report.extractorVersion}\`.`,
    `- Wygenerowano: ${report.generatedAt}.`,
    `- Dokumenty: ${int(c.documents)} (${(c.bytes / 1_000_000).toFixed(2).replace('.', ',')} MB), oznaczone wystąpienia: ${int(c.truthRows)} — pozytywne ${int(c.positives)}, trudne negatywy ${int(c.negatives)}, niesprawdzalne ${int(c.unverifiable)}, sekrety ${int(report.secrets.total)}.`,
    `- Szablony: ${Object.entries(c.templates)
      .map(([lang, n]) => `${lang.toUpperCase()} ${n}`)
      .join(', ')}.`,
    '- Dopasowanie: na poziomie adresów w obrębie dokumentu (sieć z listy sieci, na których bajty są poprawne) oraz na poziomie wystąpień (zakres w źródle dokumentu, tolerancja ±2 znaki). Przedziały ufności: bootstrap po dokumentach, 1000 prób, stałe ziarno.',
    '',
    '## Podsumowanie',
    '',
    ...summaryTable(report),
    '',
    '## Progi (bramka CI)',
    '',
    '| Próg | Wartość | Wymaganie | Wynik | Szczegóły |',
    '| --- | --: | --- | --- | --- |',
    ...report.gates.map(
      (g) =>
        `| ${g.label} | ${gateValue(g.value, g.metric)} | ${g.comparison === '<' ? '<' : g.comparison === '==' ? '=' : '≥'} ${gateValue(g.threshold, g.metric)} | ${g.passed ? 'spełniony' : '**NIE SPEŁNIONY**'} | ${g.detail ?? ''} |`,
    ),
    '',
    '## Według sieci (poziom adresów)',
    '',
    ...METRIC_HEADER,
    metricRow('wszystkie', report.overall),
    ...Object.entries(report.byChain).map(([k, m]) => metricRow(CHAIN_PL[k] ?? k, m)),
    '',
    '## Według podtypu (poziom adresów)',
    '',
    ...METRIC_HEADER,
    ...Object.entries(report.bySubtype).map(([k, m]) => metricRow(`\`${k}\``, m)),
    '',
    '## Według zaciemnienia (poziom wystąpień)',
    '',
    ...METRIC_HEADER,
    ...Object.entries(report.byObfuscation).map(([k, m]) => metricRow(OBFUSCATION_PL[k] ?? k, m)),
    '',
    '## Według kanału (poziom wystąpień)',
    '',
    ...METRIC_HEADER,
    ...Object.entries(report.byChannel).map(([k, m]) => metricRow(CHANNEL_PL[k] ?? k, m)),
    '',
    '## Grupy progów',
    '',
    ...METRIC_HEADER,
    ...Object.entries(report.gateMetrics.cleanMetrics).map(([k, m]) =>
      metricRow(`${CHAIN_PL[k] ?? k}: czyste formaty z sumą kontrolną`, m),
    ),
    metricRow('zaciemnione wystąpienia', report.gateMetrics.obfuscated),
    metricRow(
      'bez sumy kontrolnej, z potwierdzeniem (URI, eksplorator, słowo kluczowe)',
      report.gateMetrics.corroborated,
    ),
    '',
    '## Przypisanie sieci',
    '',
    '| Wycinek | Poprawne | Wszystkie | Trafność |',
    '| --- | --: | --: | --: |',
    ...Object.entries(report.attribution).map(
      ([k, a]) => `| ${ATTRIBUTION_PL[k] ?? k} | ${int(a.correct)} | ${int(a.total)} | ${pct(a.accuracy)} |`,
    ),
    '',
    `## Wskazówki ról (pierwsza wskazówka; macro-F1 ${pct(report.roleMacroF1)})`,
    '',
    '| Rola | TP | FP | FN | Precyzja | Czułość | F1 |',
    '| --- | --: | --: | --: | --: | --: | --: |',
    ...Object.entries(report.roles.byRole).map(
      ([k, r]) =>
        `| ${ROLE_PL[k] ?? k} | ${int(r.tp)} | ${int(r.fp)} | ${int(r.fn)} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} |`,
    ),
    '',
    '## Sekrety (maskowanie)',
    '',
    `Czułość ${pct(report.secrets.recall)} (${int(report.secrets.redacted)}/${int(report.secrets.total)}), wycieki fragmentów (12 znaków) w wynikach i logach: ${int(report.secrets.leaks)}. Sekrety istnieją wyłącznie w pamięci podczas pomiaru.`,
    '',
    '| Rodzaj | Liczba | Zamaskowane |',
    '| --- | --: | --: |',
    ...Object.entries(report.secrets.byKind).map(([k, s]) => `| \`${k}\` | ${int(s.total)} | ${int(s.redacted)} |`),
    '',
    '## Trudne negatywy',
    '',
    '| Rodzaj | Oczekiwanie | Liczba | Przyjęte przez OŁCyŚ | Odrzucone z oczekiwanym kodem | Przyjęte przez SpiderFoot |',
    '| --- | --- | --: | --: | --: | --: |',
    ...Object.entries(report.negatives).map(([k, n]) => {
      const expectation = n.expected;
      const coded = n.rejectCode ? `${int(n.rejectedAsExpected)} (\`${n.rejectCode}\`)` : '—';
      return `| ${NEGATIVE_PL[k] ?? k} | ${EXPECTATION_PL[expectation] ?? expectation} | ${int(n.total)} | ${int(n.accepted)} | ${coded} | ${int(n.spiderfootAccepted)} |`;
    }),
    '',
    'Wartości „niesprawdzalne” są poprawnymi adresami pod względem formatu (brak sumy kontrolnej), więc ich wyodrębnienie nie jest liczone jako fałszywy alarm; kody odrzuceń sprawdzane są na liście odrzuceń ekstraktora.',
    '',
    '## Porównanie z SpiderFoot',
    '',
    `SpiderFoot (\`${report.baselines.spiderfoot === 'not_run' ? 'not_run' : report.baselines.spiderfoot.version}\`) wykrywa wyłącznie Bitcoin i Ethereum; uruchomiono jego wyrażenia regularne na surowym tekście dokumentu (tak jak na pobranej treści strony).`,
    '',
    ...METRIC_HEADER,
    metricRow('OŁCyŚ — Bitcoin i EVM', report.comparisonChains.ours),
    metricRow('SpiderFoot — Bitcoin i EVM', report.comparisonChains.spiderfoot),
    metricRow(
      `OŁCyŚ — dokumenty z trudnymi negatywami (${int(report.hardNegativeDocuments.documents)})`,
      report.hardNegativeDocuments.ours,
    ),
    metricRow('SpiderFoot — dokumenty z trudnymi negatywami', report.hardNegativeDocuments.spiderfoot),
    ...(report.baselines.spiderfoot === 'not_run'
      ? []
      : Object.entries(report.baselines.spiderfoot.byChain).map(([k, m]) =>
          metricRow(`SpiderFoot — ${CHAIN_PL[k] ?? k}`, m),
        )),
    '',
    `iocsearcher: ${report.baselines.iocsearcher === 'not_run' ? 'nie uruchomiono (`not_run`)' : 'wyniki w report.json'}.`,
    '',
    '## Nieuruchomione kanały',
    '',
    '- Kody QR i OCR (`qr`, `ocr`): `not_run` — korpus nie zawiera jeszcze obrazów, a ekstraktor nie ma kanału obrazów.',
    '',
    '## Sieci nieobsługiwane — nie mierzono',
    '',
    '| Rodzina | Formaty | Planowana liczba przykładów |',
    '| --- | --- | --: |',
    ...report.unsupported.map(
      (u) => `| \`${u.family}\` | ${UNSUPPORTED_PL[u.family] ?? u.formats} | ${int(u.planned)} |`,
    ),
    '',
    '## Przepustowość',
    '',
    `${report.throughput.docsPerSecond.toFixed(0)} dokumentów/s, ${report.throughput.mbPerSecond.toFixed(2).replace('.', ',')} MB/s (sam \`extractCapture\`, jeden wątek).`,
    '',
    '## Błędy',
    '',
    `- Pominięte wystąpienia (FN): ${int(report.failures.falseNegatives.length)}${
      report.failures.falseNegatives.length > 0
        ? ` — np. ${report.failures.falseNegatives
            .slice(0, 10)
            .map((f) => `\`${f.docId}#${f.occurrence}\` (${f.obfuscation.join(', ') || f.channel})`)
            .join(', ')}`
        : ''
    }.`,
    `- Fałszywe alarmy (FP): ${int(report.failures.falsePositives.length)}${
      report.failures.falsePositives.length > 0
        ? ` — np. ${report.failures.falsePositives
            .slice(0, 10)
            .map((f) => `\`${f.docId}\` (${f.reason})`)
            .join(', ')}`
        : ''
    }.`,
    `- Błędy przypisania sieci: ${int(report.failures.attributionErrors.length)}${
      report.failures.attributionErrors.length > 0
        ? ` — np. ${report.failures.attributionErrors
            .slice(0, 5)
            .map(
              (f) => `\`${f.docId}#${f.occurrence}\` oczekiwano \`${f.expected}\`, jest \`${f.actual}\` (${f.method})`,
            )
            .join(', ')}`
        : ''
    }.`,
    `- Niespełnione progi: ${report.failures.gateFailures.length > 0 ? report.failures.gateFailures.map((g) => `\`${g}\``).join(', ') : 'brak'}.`,
    '',
  );
  return out.join('\n');
}
