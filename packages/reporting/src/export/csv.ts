/**
 * CSV tables of a report (links, evidence, cash-out, changes): UTF-8 with BOM, comma separated, CRLF, RFC 4180 quoting,
 * English snake_case headers (data, not UI). Text cells are protected against spreadsheet formula injection; numbers and
 * decimals are written exactly as stored.
 */
import type { Capture, CashOutEvent } from '@olcys/core';
import { addressKey } from '@olcys/core';
import { cmp, icdTerm } from '../view.ts';
import { selectLinks, type ExportInput } from './select.ts';

export const CSV_EXPORTS = ['csv_links', 'csv_evidence', 'csv_cash_out', 'csv_changes'] as const;
export type CsvExport = (typeof CSV_EXPORTS)[number];

const HEADERS: Record<CsvExport, readonly string[]> = {
  csv_links: [
    'case_id',
    'run_id',
    'identity',
    'chain',
    'address',
    'relation',
    'tier',
    'score',
    'icd203_pl',
    'analytic_confidence',
    'algorithm_version',
    'weights_version',
    'weights_sha256',
    'evidence_capture_ids',
    'evidence_urls',
  ],
  csv_evidence: [
    'capture_id',
    'source_id',
    'url',
    'final_url',
    'status',
    'collected_at',
    'collector',
    'manifest_sha256',
    'tsa_gen_time',
    'tsa_url',
  ],
  csv_cash_out: [
    'event_id',
    'rule_id',
    'strength',
    'occurred_at',
    'address',
    'counterparty_entity',
    'tx_hashes',
    'amount',
    'asset',
    'pln',
    'nbp_table',
    'nbp_effective_date',
    'nbp_rate',
    'pln_synthetic',
  ],
  csv_changes: [
    'kind',
    'platform',
    'locator',
    'property',
    'before',
    'after',
    'before_capture_id',
    'after_capture_id',
    'score_before',
    'score_after',
    'cause',
  ],
};

/** Quotes a cell when needed; with `text` a leading formula character (`= + - @`, TAB, CR) gets a `'` prefix. */
export function csvCell(value: string, o: { text: boolean }): string {
  const guarded = o.text && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** A cell: text (guarded) or a number / DecimalString written verbatim. */
type Cell = string | { num: string | number | undefined } | undefined;

const cell = (c: Cell): string =>
  c === undefined
    ? ''
    : typeof c === 'string'
      ? csvCell(c, { text: true })
      : csvCell(String(c.num ?? ''), { text: false });
const num = (n: string | number | undefined): Cell => ({ num: n });

function table(kind: CsvExport, rows: Cell[][]): string {
  const lines = [HEADERS[kind].join(','), ...rows.map((r) => r.map(cell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * `true` when the PLN value rests on a synthetic (demo) rate, in the event or in any of its components; `false` for
 * official NBP rates; empty when the event has no valuation.
 */
function syntheticFlag(e: CashOutEvent): string {
  const valuations = [e.valuation, ...(e.components ?? []).map((c) => c.valuation)].filter((v) => v !== undefined);
  if (!valuations.length) return '';
  return String(valuations.some((v) => v.nbp.synthetic === true));
}

const urlOf = (c: Capture) => c.finalUrl || c.url;

export function toCsv(kind: CsvExport, input: ExportInput): string {
  const { data } = input;
  switch (kind) {
    case 'csv_links': {
      const { view, links } = selectLinks(input);
      return table(
        kind,
        links.map(({ link, captures }) => [
          data.case.id,
          data.run.id,
          view.identityLabel(link.identityId),
          link.address.chain,
          link.address.address,
          link.relation,
          link.tier,
          num(link.score),
          icdTerm(link),
          link.analyticConfidence,
          link.algorithmVersion,
          link.weightsVersion,
          link.weightsSha256,
          captures.map((c) => c.id).join(';'),
          captures.map(urlOf).join(';'),
        ]),
      );
    }
    case 'csv_evidence': {
      const { view } = selectLinks(input);
      return table(
        kind,
        view.captures.map((c) => [
          c.id,
          c.sourceId,
          c.url,
          c.finalUrl,
          c.status,
          c.collectedAt,
          c.collector,
          c.manifestSha256,
          c.timestamp?.genTime,
          c.timestamp?.tsaUrl,
        ]),
      );
    }
    case 'csv_cash_out':
      return table(
        kind,
        data.cashOuts
          .toSorted((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.id, b.id))
          .map((e) => [
            e.id,
            e.ruleId,
            e.strength,
            e.occurredAt,
            addressKey(e.address),
            e.counterparty.entity ?? e.counterparty.address,
            e.txHashes.join(';'),
            num(e.amount),
            e.asset,
            num(e.valuation?.pln ?? e.plnTotal),
            e.valuation?.nbp.table,
            e.valuation?.nbp.effectiveDate,
            num(e.valuation?.nbp.rate),
            syntheticFlag(e),
          ]),
      );
    case 'csv_changes':
      return table(
        kind,
        data.changes.map((c) => [
          c.kind,
          c.key.platform,
          c.key.locator,
          c.key.property,
          c.before,
          c.after,
          c.beforeCaptureId,
          c.afterCaptureId,
          num(c.scoreBefore),
          num(c.scoreAfter),
          c.cause,
        ]),
      );
  }
}
