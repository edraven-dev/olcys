import { pl } from './format.ts';
import type { CalibrationReport } from './report.ts';
import type { Estimate } from './metrics.ts';

const est = (e: Estimate, digits = 4): string =>
  `${pl(e.value, digits)} (95 % CI ${pl(e.ci95[0], digits)}–${pl(e.ci95[1], digits)})`;
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

/** Polish Markdown report (feeds the methodology annex). */
export function reportMarkdown(r: CalibrationReport): string {
  const lines: string[] = [
    `# Raport kalibracji — ${r.weightsVersion}`,
    '',
    `> ${r.notice}`,
    '',
    `- Algorytm: \`${r.algorithmVersion}\`, reguły relacji: \`${r.rulesVersion}\`, wagi: \`${r.weightsVersion}\` (status: ${r.weightsStatus}, SHA-256 \`${r.weightsSha256}\`).`,
    `- Tryb: \`${r.mode}\`, ziarno ${r.seed}, n = ${r.n}, zbiór danych SHA-256 \`${r.datasetSha256}\`.`,
    `- Średnie prawdopodobieństwo przewidywane ${pl(r.meanPredicted)}, zaobserwowana częstość ${pl(r.observedRate)}.`,
    '',
    '## Wskaźniki',
    '',
    row(['Miara', 'Wartość']),
    row(['---', '---']),
    row(['Brier', est(r.brier)]),
    row(['Logarytmiczna funkcja straty', est(r.logLoss)]),
    row(['ECE (10 przedziałów)', est(r.ece)]),
    '',
    '## Diagram niezawodności (przedziały)',
    '',
    row(['Przedział', 'n', 'Przewidywane', 'Zaobserwowane']),
    row(['---', '---', '---', '---']),
    ...r.bins.map((b) =>
      row([
        `[${pl(b.lower, 1)}; ${pl(b.upper, 1)}${b.upper === 1 ? ']' : ')'}`,
        b.count,
        pl(b.meanPredicted),
        pl(b.observedRate),
      ]),
    ),
    '',
    'Wykres: `reliability.svg` w tym samym katalogu.',
    '',
    '## Scenariusze',
    '',
    row(['Scenariusz', 'n', 'Przewidywane', 'Zaobserwowane', 'Brier']),
    row(['---', '---', '---', '---', '---']),
    ...Object.entries(r.byScenario).map(([id, s]) =>
      row([`\`${id}\``, s.n, pl(s.meanPredicted), pl(s.observedRate), pl(s.brier)]),
    ),
    '',
    '## Relacje i poziomy dowodów',
    '',
    row(['Grupa', 'n', 'Brier']),
    row(['---', '---', '---']),
    ...Object.entries(r.byRelation).map(([id, s]) => row([`relacja \`${id}\``, s.n, pl(s.brier)])),
    ...Object.entries(r.byTier).map(([id, s]) => row([`poziom \`${id}\``, s.n, pl(s.brier)])),
    '',
    '## Empiryczne ilorazy wiarygodności cech',
    '',
    r.mode === 'oracle'
      ? 'Tryb `oracle`: cechy losowane z ilorazów wag, więc LR empiryczny powinien wracać do BF′ (cechy rzadkie, z mniej niż 30 wystąpieniami w klasie, są ostrzeżeniem `sparse`).'
      : 'Uwaga: w trybie `scenarios` cechy są przypisane do scenariuszy z góry, więc LR empiryczny odzwierciedla założenia scenariuszy, a nie pomiar; porównanie z wagami ma sens tylko w trybie `oracle`.',
    '',
    row(['Cecha', 'obecna (prawda)', 'obecna (fałsz)', 'LR empiryczny', 'BF z wag', "BF' z wag"]),
    row(['---', '---', '---', '---', '---', '---']),
    ...Object.entries(r.features).map(([key, f]) =>
      row([
        `\`${key}\``,
        `${f.present1}/${f.total1}`,
        `${f.present0}/${f.total0}`,
        pl(f.empiricalLr, 2),
        pl(f.weightBf, 2),
        pl(f.weightBfPrime, 2),
      ]),
    ),
    '',
  ];
  if (r.relationAccuracy) {
    const a = r.relationAccuracy;
    const classes = [
      ...new Set([...Object.keys(a.confusion), ...Object.values(a.confusion).flatMap((v) => Object.keys(v))]),
    ].toSorted();
    lines.push(
      '## Trafność relacji na korpusie',
      '',
      `Makro-F1: ${pl(a.macroF1)} (n = ${a.n}, pominięto ${a.unmatched} adresów bez roszczenia). Wiersz: relacja z prawdy wzorcowej, kolumna: relacja przypisana.`,
      '',
      row(['', ...classes]),
      row(['---', ...classes.map(() => '---')]),
      ...classes.map((t) => row([`\`${t}\``, ...classes.map((c) => a.confusion[t]?.[c] ?? 0)])),
      '',
    );
  }
  if (r.persona) {
    lines.push(
      '## Zestaw kontrolny persony',
      '',
      row(['Roszczenie', 'Oczekiwane', 'Obliczone', 'Wynik']),
      row(['---', '---', '---', '---']),
      ...r.persona.map((p) =>
        row([`\`${p.claim}\``, p.expected, p.got, p.expected === p.got ? 'zgodne' : 'NIEZGODNE']),
      ),
      '',
    );
  }
  lines.push('## Ostrzeżenia', '', ...(r.warnings.length === 0 ? ['Brak.'] : r.warnings.map((w) => `- \`${w}\``)), '');
  return lines.join('\n');
}
