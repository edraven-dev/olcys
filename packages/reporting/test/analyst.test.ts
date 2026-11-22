import type { AnalysisRun, AnalystJudgement, AnalystOverride, LinkAssessment } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData, renderReport, type ReportData } from '../src/index.ts';
import { A, personaData } from './fixtures.ts';

const judgement = (linkAssessmentId: string, value: AnalystJudgement['judgement'], at: string, text: string) => ({
  id: `0190b000-0000-7000-8000-${at.slice(11, 13)}${at.slice(14, 16)}00000000`,
  linkAssessmentId,
  judgement: value,
  justification: text,
  analyst: 'Analityk Testowy',
  at,
});

/** A distinct synthetic justification, to count where it appears. */
const text = (n: number) => `Uzasadnienie oceny numer ${n} (test syntetyczny)`;

/** The card of one link in chapter 3. */
function card(html: string, linkId: string): string {
  const start = html.indexOf(`<article class="card" id="powiazanie-${linkId}">`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</article>', start));
}

describe('analyst statements in the report', () => {
  it('shows judgements as separate statements next to the unchanged computed score', () => {
    const base = personaData();
    const data: ReportData = {
      ...base,
      judgements: [
        judgement('link-eth2', 'unsure', '2026-11-21T11:00:00.000Z', 'Trzeba sprawdzić drugie konto.'),
        judgement('link-eth2', 'not_same', '2026-11-21T11:30:00.000Z', 'Inny autor <script>alert(1)</script>'),
      ],
    };
    const before = card(renderReport(base), 'link-eth2');
    const after = card(renderReport(data), 'link-eth2');
    expect(before).not.toContain('data-statement="ocena-analityka"');
    expect(after).toContain('<div class="blk blk-ocena-analityka" data-statement="ocena-analityka">');
    expect(after).toContain('Aktualna ocena analityka: Powiązanie odrzucone.');
    expect(after).toContain('Niepewne');
    expect(after).toContain('Analityk Testowy, 2026-11-21 11:30:00 UTC');
    expect(after).toContain('Ocena jest zapisywana obok wyniku i nie zmienia obliczonego Wskaźnika Pewności.');
    expect(after).toContain('&lt;script&gt;');
    expect(after).not.toContain('<script>');
    // Apart from the added block the card — facts, computed score, inferences — is identical.
    const from = after.indexOf('<div class="blk blk-ocena-analityka"');
    const to = after.indexOf('</div>', from) + '</div>'.length;
    expect(after.slice(0, from) + after.slice(to)).toBe(before);
    expect(after).toContain('<span class="score">24/100</span>');
    // Links without judgements are untouched.
    expect(card(renderReport(data), 'link-btc1')).not.toContain('ocena-analityka');
  });

  it('shows judgements on rejected and third-party links too, each statement exactly once', () => {
    const base = personaData();
    const data: ReportData = {
      ...base,
      judgements: [
        judgement('link-eth2', 'not_same', '2026-11-21T11:00:00.000Z', text(1)),
        judgement('link-tron2', 'same', '2026-11-21T11:10:00.000Z', text(2)),
        judgement('link-eth1', 'unsure', '2026-11-21T11:20:00.000Z', text(3)),
      ],
    };
    const html = renderReport(data);
    for (const n of [1, 2, 3]) expect(html.split(text(n)).length - 1).toBe(1);
    // The third-party attribution has its own card in chapter 4.
    const thirdParty = html.slice(html.indexOf('id="strona-trzecia-link-tron2"'));
    expect(thirdParty.slice(0, thirdParty.indexOf('</article>'))).toContain(text(2));
    // The exchange deposit (rejected by a rule) is covered by the block for links without a card of their own.
    const rejected = html.slice(html.indexOf('<section class="report-section" id="odrzucone">'));
    const other = rejected.slice(rejected.indexOf('<h3>Oceny analityka dotyczące odrzuconych powiązań</h3>'));
    expect(other.startsWith('<h3>Oceny analityka dotyczące odrzuconych powiązań</h3>')).toBe(true);
    expect(other).toContain(text(3));
    expect(other).toContain(A.ETH1);
    expect(renderReport({ ...base, judgements: [data.judgements![0]!] })).not.toContain(
      'Oceny analityka dotyczące odrzuconych powiązań',
    );
  });

  it('lists the overrides a rescore run applied', () => {
    const base = personaData();
    const override: AnalystOverride = {
      id: '0190b000-0000-7000-8000-000000000001',
      caseId: base.case.id,
      kind: 'add_evidence',
      target: { accountId: base.accounts[0]!.id },
      value: 'contradicting_attribute',
      justification: 'Inny język wpisów niż w pozostałych źródłach',
      analyst: 'Analityk Testowy',
      at: '2026-11-21T09:00:00.000Z',
    };
    const grade: AnalystOverride = {
      ...override,
      id: '0190b000-0000-7000-8000-000000000002',
      kind: 'reliability_grade',
      target: { sourceId: 'wykop' },
      value: 'B',
    };
    const html = renderReport({
      ...base,
      run: { ...base.run, trigger: 'rescore', rescoreOfRunId: 'run-0001' },
      overrides: [override, grade],
    });
    expect(html).toContain('Korekty analityka uwzględnione w tym przebiegu');
    expect(html).toContain('Przesłanka dodana przez analityka');
    expect(html).toContain('Ocena wiarygodności');
    expect(html).toContain('Inny język wpisów niż w pozostałych źródłach');
    expect(html).toContain('<h3>Ocena i korekty analityka</h3>');
    expect(renderReport(base)).not.toContain('Korekty analityka uwzględnione w tym przebiegu');
  });

  it('loads the judgements of the run and the overrides a rescore applied from the store', async () => {
    const repos = createMemoryRepositories();
    const kase = await repos.cases.create(
      {
        title: 'Kacper Fikcyjny (test raportu)',
        purpose: 'Test raportu na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
        scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
      },
      'test',
    );
    const base = personaData();
    const run = (trigger: AnalysisRun['trigger']): AnalysisRun => ({
      ...base.run,
      id: newId(),
      caseId: kase.id,
      trigger,
      status: 'succeeded',
      queuedAt: '2026-11-21T12:00:00.000Z',
    });
    const manual = run('manual');
    // The rescore fixed its override set when it was queued (the worker records the ids in the snapshot).
    const rescore = {
      ...run('rescore'),
      rescoreOfRunId: manual.id,
      config: { ...base.run.config, analystOverrides: ['0190b000-0000-7000-8000-000000000011'] },
    };
    delete manual.previousRunId;
    delete rescore.previousRunId;
    await repos.runs.create(manual);
    await repos.runs.create(rescore);
    const link: LinkAssessment = {
      ...base.links[0]!,
      id: newId(),
      runId: rescore.id,
      identityId: kase.identifiers[0]!.id,
    };
    await repos.analysis.addLinks([link]);
    const later = judgement(link.id, 'same', '2026-11-21T13:30:00.000Z', 'Potwierdzone w drugim źródle.');
    const earlier = judgement(link.id, 'unsure', '2026-11-21T13:00:00.000Z', 'Wymaga dalszej weryfikacji.');
    await repos.judgements!.add(later);
    await repos.judgements!.add(earlier);
    const at = (iso: string, id: string): AnalystOverride => ({
      id,
      caseId: kase.id,
      kind: 'reliability_grade',
      target: { sourceId: 'wykop' },
      value: 'C',
      justification: 'Ocena źródła na danych syntetycznych',
      analyst: 'Analityk Testowy',
      at: iso,
    });
    const applied = at('2026-11-21T11:00:00.000Z', '0190b000-0000-7000-8000-000000000011');
    await repos.overrides!.add(at('2026-11-21T12:30:00.000Z', '0190b000-0000-7000-8000-000000000012'));
    // Recorded before the queue time but not part of the run's fixed set (it landed after the run was queued).
    await repos.overrides!.add(at('2026-11-21T11:30:00.000Z', '0190b000-0000-7000-8000-000000000013'));
    await repos.overrides!.add(applied);

    const data = await buildReportData(repos, rescore.id);
    expect(data.judgements?.map((j) => j.id)).toEqual([earlier.id, later.id]);
    expect(data.overrides).toEqual([applied]);
    const collected = await buildReportData(repos, manual.id);
    expect('judgements' in collected || 'overrides' in collected).toBe(false);
    expect(renderReport(data)).toContain(A.ETH2);
  });
});
