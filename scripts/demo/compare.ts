/** Pure comparison of what the API returned with the demo manifest's expectations. */
import type { Expectations, Slot } from './expectations.ts';
import { pl } from './pl.ts';

export interface AddressRefLike {
  chain: string;
  address: string;
}
export interface LinkLike {
  address: AddressRefLike;
  score: number;
  relation: string;
  band?: string;
  icd203?: string;
}
export interface ExclusionLike {
  address: AddressRefLike;
  ruleId: string;
  reason: string;
  outcome?: string;
}
export interface ExtractionLike {
  rejected: { raw: string; reason: string }[];
}
export interface CashOutLike {
  address: AddressRefLike;
  ruleId: string;
  strength?: string;
  amount?: string;
  asset?: string;
}
export interface ChangeLike {
  kind: string;
  key: { property: string; locator?: string };
  before?: string;
  after?: string;
}

export interface RunResults {
  runId: string;
  status: string;
  links: LinkLike[];
  exclusions: ExclusionLike[];
  extractions: ExtractionLike[];
  cashOuts: CashOutLike[];
  changes: ChangeLike[];
  /** HTML of the run's report, when it could be read. */
  reportHtml?: string;
}

export interface Mismatch {
  check: string;
  expected: string;
  actual: string;
}

export interface CompareOutcome {
  checks: number;
  mismatches: Mismatch[];
}

const lc = (value: string | undefined): string => (value ?? '').toLowerCase();
const list = (values: readonly (string | number)[]): string => (values.length === 0 ? '(none)' : values.join(', '));

export function compareRuns(expect: Expectations, v1: RunResults, v2: RunResults): CompareOutcome {
  const mismatches: Mismatch[] = [];
  let checks = 0;
  const check = (name: string, expected: string, actual: string, ok: boolean) => {
    checks += 1;
    if (!ok) mismatches.push({ check: name, expected, actual });
  };
  const scoresOf = (run: RunResults, slot: Slot) =>
    run.links.filter((l) => lc(l.address.address) === slot.address).map((l) => l.score);

  for (const [index, run] of [v1, v2].entries()) {
    const n = index + 1;
    check(pl.checks.status(n), 'succeeded|partial', run.status, run.status === 'succeeded' || run.status === 'partial');
  }

  for (const l of expect.v1.links) {
    const scores = scoresOf(v1, l);
    check(pl.checks.link(1, l.slot), String(l.score), list(scores), scores.includes(l.score));
  }
  for (const slot of expect.v1.zeroScore) {
    const scores = scoresOf(v1, slot);
    check(
      pl.checks.zero(1, slot.slot),
      '0 or none',
      list(scores),
      scores.every((s) => s === 0),
    );
  }
  const documentationExamples = new Set(
    v1.extractions
      .flatMap((r) => r.rejected)
      .filter((r) => r.reason.startsWith('documentation_example'))
      .map((r) => lc(r.raw)),
  );
  for (const r of expect.v1.rejected) {
    const rules = v1.exclusions.filter((d) => lc(d.address.address) === r.address).map((d) => d.ruleId);
    // A documentation vector may already be rejected by the extractor's deny list, before it becomes a candidate.
    const ok = rules.includes(r.rule) || (r.rule === 'A8' && documentationExamples.has(r.address));
    check(
      pl.checks.rejected(1, r.slot, r.rule),
      r.rule,
      list(rules.length > 0 ? rules : documentationExamples.has(r.address) ? ['A8 (extractor)'] : []),
      ok,
    );
  }
  for (const c of expect.v1.cashOut) {
    const rules = v1.cashOuts.filter((e) => lc(e.address.address) === c.address).map((e) => e.ruleId);
    check(pl.checks.cashOut(1, c.slot, c.rule), c.rule, list(rules), rules.includes(c.rule));
  }

  for (const l of expect.v2.links) {
    const scores = scoresOf(v2, l);
    check(pl.checks.link(2, l.slot), String(l.score), list(scores), scores.includes(l.score));
  }
  for (const c of expect.v2.changes) {
    const found = v2.changes.filter((x) => x.kind === c.kind && x.key.property === c.property);
    check(
      pl.checks.change(2, c.property),
      `${c.kind} ${c.from.display} -> ${c.to.display}`,
      list(found.map((x) => `${x.kind} ${x.before} -> ${x.after}`)),
      found.some((x) => lc(x.before) === c.from.address && lc(x.after) === c.to.address),
    );
  }

  // The stored Polish reports show the persona's declared wallet of each run (skipped when they could not be read).
  const reportChecks: [number, RunResults, Slot | undefined][] = [
    [1, v1, expect.addressOf('BTC-1')],
    [2, v2, expect.addressOf('BTC-2')],
  ];
  for (const [n, run, slot] of reportChecks) {
    if (!slot) continue;
    const html = run.reportHtml;
    check(
      pl.checks.report(n, slot.slot),
      slot.display,
      html === undefined ? '(report not readable)' : html.includes(slot.display) ? slot.display : '(absent)',
      html?.includes(slot.display) ?? false,
    );
  }
  return { checks, mismatches };
}

export function formatMismatches(mismatches: readonly Mismatch[]): string {
  if (mismatches.length === 0) return '';
  return [pl.mismatch.header, ...mismatches.map((m) => pl.mismatch.line(m.check, m.expected, m.actual))].join('\n');
}
