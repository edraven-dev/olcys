/** Polish, human-readable summary of the two demo runs. Pure: returns lines, prints nothing. */
import type { CompareOutcome, RunResults } from './compare.ts';
import { formatMismatches } from './compare.ts';
import type { Expectations } from './expectations.ts';
import { pl } from './pl.ts';

export interface SummaryInput {
  caseId: string;
  apiUrl: string;
  webUrl: string;
  v1: RunResults;
  v2: RunResults;
  expect: Expectations;
  outcome: CompareOutcome;
}

const lc = (value: string): string => value.toLowerCase();

export function summarise(input: SummaryInput): string[] {
  const { expect, v1, v2, outcome } = input;
  const label = (address: string): string => {
    const slot = expect.slotOf.get(lc(address));
    return slot ? `${slot} (${address})` : address;
  };
  const s = pl.summary;
  const lines: string[] = ['', `=== ${pl.title} ===`, '', `${s.case}: ${input.caseId}`];

  lines.push('', `${s.links}:`);
  const links = [...v1.links].toSorted((a, b) => b.score - a.score);
  for (const l of links) {
    const band = l.band ? (pl.band[l.band] ?? l.band) : '-';
    lines.push(
      `  ${String(l.score).padStart(3)}  ${band.padEnd(15)} ${l.relation.padEnd(26)} ${label(l.address.address)}`,
    );
  }
  if (links.length === 0) lines.push(`  ${s.none}`);

  lines.push('', `${s.rejected}:`);
  const rejected = new Map<string, string>();
  for (const r of expect.v1.rejected) {
    const found = v1.exclusions.find((d) => lc(d.address.address) === r.address && d.ruleId === r.rule);
    const documentation = v1.extractions
      .flatMap((x) => x.rejected)
      .some((x) => lc(x.raw) === r.address && x.reason.startsWith('documentation_example'));
    if (found || documentation) {
      rejected.set(
        `${r.address}:${r.rule}`,
        `  ${r.rule}  ${label(r.display)}: ${pl.exclusionRules[r.rule] ?? r.rule}`,
      );
    }
  }
  lines.push(...(rejected.size > 0 ? [...rejected.values()] : [`  ${s.none}`]));

  lines.push('', `${s.cashOut}:`);
  const cashOuts = v1.cashOuts.map((e) => {
    const amount = e.amount && e.asset ? `, ${e.amount} ${e.asset}` : '';
    return `  ${e.ruleId}  ${label(e.address.address)}: ${pl.cashOutRules[e.ruleId] ?? e.ruleId}${amount}`;
  });
  lines.push(...(cashOuts.length > 0 ? cashOuts : [`  ${s.none}`]));

  lines.push('', `${s.alert}:`);
  const swaps = v2.changes.filter((c) => c.kind === 'VALUE_CHANGED' && c.key.property === 'profile.bitcoin_address');
  for (const c of swaps) lines.push(`  ! ${s.alertText(label(c.before ?? '?'), label(c.after ?? '?'))}`);
  if (swaps.length === 0) lines.push(`  ${s.none}`);

  lines.push('', `${s.linksV2}:`);
  for (const l of v2.links.filter((x) => x.score > 0).toSorted((a, b) => b.score - a.score)) {
    lines.push(
      `  ${String(l.score).padStart(3)}  ${(l.band ? (pl.band[l.band] ?? l.band) : '-').padEnd(15)} ${label(l.address.address)}`,
    );
  }

  lines.push(
    '',
    `${s.ui}: ${input.webUrl}/sprawy/${input.caseId}`,
    `${s.report}: ${input.apiUrl}/api/runs/${v1.runId}/report`,
    `${s.reportV2}: ${input.apiUrl}/api/runs/${v2.runId}/report`,
    '',
  );
  lines.push(
    outcome.mismatches.length === 0 ? s.selfCheckOk(outcome.checks) : s.selfCheckFail(outcome.mismatches.length),
  );
  if (outcome.mismatches.length > 0) lines.push(formatMismatches(outcome.mismatches));
  lines.push('', s.notice);
  return lines;
}
