/**
 * Polish Markdown rendering of a `BenchReport` (`report.md`). Pure: numbers come from the report object only,
 * every string from the Polish catalogue (`pl.ts`).
 */
import {
  ATTRIBUTION_PL,
  CHANNEL_PL,
  CHAIN_PL,
  EXPECTATION_PL,
  NEGATIVE_PL,
  OBFUSCATION_PL,
  REPORT_PL as T,
  ROLE_PL,
  UNSUPPORTED_PL,
} from './pl.ts';
import type { BenchReport, Metrics } from './types.ts';

/** Polish percentage with two decimals (`99,19 %`); `—` when undefined. */
export function pct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2).replace('.', ',')} %`;
}

function ci(range: readonly [number, number]): string {
  if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) return '—';
  return `${pct(range[0])} – ${pct(range[1])}`;
}

/** Integer with a space as the thousands separator (`1 232`). */
const int = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const decimal = (n: number, digits: number): string => n.toFixed(digits).replace('.', ',');

function metricRow(label: string, m: Metrics | 'not_run'): string {
  if (m === 'not_run') return `| ${label} | — | — | — | ${T.notRun} | — | — |`;
  return `| ${label} | ${int(m.tp)} | ${int(m.fp)} | ${int(m.fn)} | ${pct(m.precision)} (${ci(m.precisionCi95)}) | ${pct(m.recall)} (${ci(m.recallCi95)}) | ${pct(m.f1)} |`;
}

function gateValue(value: number, metric: string): string {
  return metric === 'value' && Number.isInteger(value) ? int(value) : pct(value);
}

const comparisonSign = (c: string): string => (c === '<' ? '<' : c === '==' ? '=' : '≥');

/** The headline table (copied into the methodology note). */
export function summaryTable(report: BenchReport): string[] {
  const rows: [string, string, Metrics][] = [
    [T.ours, T.scopeAll, report.overall],
    [T.ours, T.scopeComparison, report.comparisonChains.ours],
    [T.spiderfoot, T.scopeComparison, report.comparisonChains.spiderfoot],
    [T.ours, T.scopeHardNegatives, report.hardNegativeDocuments.ours],
    [T.spiderfoot, T.scopeHardNegatives, report.hardNegativeDocuments.spiderfoot],
  ];
  return [
    ...T.summaryHeader,
    ...rows.map(([tool, scope, m]) => `| ${tool} | ${scope} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`),
  ];
}

/** ` — np. a, b` after a failure count, or nothing. */
const examples = (items: string[]): string => (items.length > 0 ? T.examples(items.join(', ')) : '');

function failureLines(report: BenchReport): string[] {
  const f = report.failures;
  return [
    T.falseNegatives(
      int(f.falseNegatives.length),
      examples(
        f.falseNegatives
          .slice(0, 10)
          .map((x) => `\`${x.docId}#${x.occurrence}\` (${x.obfuscation.join(', ') || x.channel})`),
      ),
    ),
    T.falsePositives(
      int(f.falsePositives.length),
      examples(f.falsePositives.slice(0, 10).map((x) => `\`${x.docId}\` (${x.reason})`)),
    ),
    T.attributionErrors(
      int(f.attributionErrors.length),
      examples(
        f.attributionErrors
          .slice(0, 5)
          .map((x) => T.attributionExample(`\`${x.docId}#${x.occurrence}\``, x.expected, x.actual, x.method)),
      ),
    ),
    T.gateFailures(f.gateFailures.length > 0 ? f.gateFailures.map((g) => `\`${g}\``).join(', ') : T.none),
  ];
}

export function renderReportMarkdown(report: BenchReport): string {
  const c = report.corpus;
  const sf = report.baselines.spiderfoot;
  return [
    T.title,
    '',
    T.corpus(report.corpusVersion, c.seed, report.extractorVersion),
    T.generatedAt(report.generatedAt),
    T.documents(
      int(c.documents),
      decimal(c.bytes / 1_000_000, 2),
      int(c.truthRows),
      int(c.positives),
      int(c.negatives),
      int(c.unverifiable),
      int(report.secrets.total),
    ),
    T.templates(
      Object.entries(c.templates)
        .map(([lang, n]) => `${lang.toUpperCase()} ${n}`)
        .join(', '),
    ),
    T.matching,
    '',
    T.summary,
    '',
    ...summaryTable(report),
    '',
    T.gates,
    '',
    ...T.gatesHeader,
    ...report.gates.map(
      (g) =>
        `| ${g.label} | ${gateValue(g.value, g.metric)} | ${comparisonSign(g.comparison)} ${gateValue(g.threshold, g.metric)} | ${g.passed ? T.gatePassed : T.gateFailed} | ${g.detail ?? ''} |`,
    ),
    '',
    T.byChain,
    '',
    ...T.metricHeader,
    metricRow(T.allChains, report.overall),
    ...Object.entries(report.byChain).map(([k, m]) => metricRow(CHAIN_PL[k] ?? k, m)),
    '',
    T.bySubtype,
    '',
    ...T.metricHeader,
    ...Object.entries(report.bySubtype).map(([k, m]) => metricRow(`\`${k}\``, m)),
    '',
    T.byObfuscation,
    '',
    ...T.metricHeader,
    ...Object.entries(report.byObfuscation).map(([k, m]) => metricRow(OBFUSCATION_PL[k] ?? k, m)),
    '',
    T.byChannel,
    '',
    ...T.metricHeader,
    ...Object.entries(report.byChannel).map(([k, m]) => metricRow(CHANNEL_PL[k] ?? k, m)),
    '',
    T.gateGroups,
    '',
    ...T.metricHeader,
    ...Object.entries(report.gateMetrics.cleanMetrics).map(([k, m]) => metricRow(T.cleanGroup(k), m)),
    metricRow(T.obfuscatedGroup, report.gateMetrics.obfuscated),
    metricRow(T.corroboratedGroup, report.gateMetrics.corroborated),
    '',
    T.attribution,
    '',
    ...T.attributionHeader,
    ...Object.entries(report.attribution).map(
      ([k, a]) => `| ${ATTRIBUTION_PL[k] ?? k} | ${int(a.correct)} | ${int(a.total)} | ${pct(a.accuracy)} |`,
    ),
    '',
    T.roles(pct(report.roleMacroF1)),
    '',
    ...T.rolesHeader,
    ...Object.entries(report.roles.byRole).map(
      ([k, r]) =>
        `| ${ROLE_PL[k] ?? k} | ${int(r.tp)} | ${int(r.fp)} | ${int(r.fn)} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} |`,
    ),
    '',
    T.secrets,
    '',
    T.secretsLine(
      pct(report.secrets.recall),
      int(report.secrets.redacted),
      int(report.secrets.total),
      int(report.secrets.leaks),
    ),
    '',
    ...T.secretsHeader,
    ...Object.entries(report.secrets.byKind).map(([k, s]) => `| \`${k}\` | ${int(s.total)} | ${int(s.redacted)} |`),
    '',
    T.negatives,
    '',
    ...T.negativesHeader,
    ...Object.entries(report.negatives).map(([k, n]) => {
      const coded = n.rejectCode ? `${int(n.rejectedAsExpected)} (\`${n.rejectCode}\`)` : '—';
      return `| ${NEGATIVE_PL[k] ?? k} | ${EXPECTATION_PL[n.expected] ?? n.expected} | ${int(n.total)} | ${int(n.accepted)} | ${coded} | ${int(n.spiderfootAccepted)} |`;
    }),
    '',
    T.negativesNote,
    '',
    T.comparison,
    '',
    T.comparisonLine(sf === 'not_run' ? 'not_run' : sf.version),
    '',
    ...T.metricHeader,
    metricRow(T.oursComparison, report.comparisonChains.ours),
    metricRow(T.spiderfootComparison, report.comparisonChains.spiderfoot),
    metricRow(T.oursHardNegatives(int(report.hardNegativeDocuments.documents)), report.hardNegativeDocuments.ours),
    metricRow(T.spiderfootHardNegatives, report.hardNegativeDocuments.spiderfoot),
    ...(sf === 'not_run' ? [] : Object.entries(sf.byChain).map(([k, m]) => metricRow(T.spiderfootChain(k), m))),
    '',
    T.iocsearcher(report.baselines.iocsearcher !== 'not_run'),
    '',
    T.notRunChannels,
    '',
    T.imageChannels,
    '',
    T.unsupported,
    '',
    ...T.unsupportedHeader,
    ...report.unsupported.map(
      (u) => `| \`${u.family}\` | ${UNSUPPORTED_PL[u.family] ?? u.formats} | ${int(u.planned)} |`,
    ),
    '',
    T.throughput,
    '',
    T.throughputLine(report.throughput.docsPerSecond.toFixed(0), decimal(report.throughput.mbPerSecond, 2)),
    '',
    T.failures,
    '',
    ...failureLines(report),
    '',
  ].join('\n');
}
