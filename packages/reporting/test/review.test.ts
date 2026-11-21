/** Regression tests for misattribution and double-counting risks in the report (one block per risk). */
import type { ActivityIndicators, CashOutEvent, ExclusionDecision, LinkAssessment } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { renderReport, type ReportData } from '../src/index.ts';
import { buildView } from '../src/view.ts';
import { A, personaData } from './fixtures.ts';

const NBSP = ' ';

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

/** The `<li>` of the funds-flow narrative that mentions `needle`. */
function flowEntry(html: string, needle: string): string {
  const flow = sectionOf(html, 'przeplywy');
  const at = flow.indexOf(needle);
  const start = flow.lastIndexOf('<li class="flow-step', at);
  return flow.slice(start, flow.indexOf('</li>', at) + 5);
}

const withData = (patch: (d: ReportData) => void): ReportData => {
  const data = personaData();
  patch(data);
  return data;
};

describe('report review fixes', () => {
  it('keeps the same address on different chains apart', () => {
    const polygon = { chain: 'evm:137' as const, address: A.HOT1 };
    const data = withData((d) => {
      const base = d.links.find((l) => l.id === 'link-tron1') as LinkAssessment;
      d.links.push({ ...base, id: 'link-polygon', address: polygon, score: 70, band: 'PRAWDOPODOBNE' });
      const eth = d.activity[0] as ActivityIndicators;
      d.activity.push({ ...eth, address: polygon, cashOut: { events: [], score: 0 } });
      d.activity.push({ ...eth, address: { chain: 'evm:1', address: A.HOT1 }, cashOut: { events: [], score: 0 } });
    });
    const view = buildView(data);
    expect(view.roleOf(polygon).kind).toBe('linked');
    expect(view.roleOf({ chain: 'evm:1', address: A.HOT1 }).kind).toBe('excluded');
    const html = renderReport(data);
    expect(sectionOf(html, 'powiazania')).toContain('id="powiazanie-link-polygon"');
    const activity = sectionOf(html, 'aktywnosc');
    expect(activity).toContain(`id="aktywnosc-evm:137:${A.HOT1}"`);
    expect(activity).toContain(`id="aktywnosc-evm:1:${A.HOT1}"`);
  });

  it('shows flagged decisions as warnings, not rejections', () => {
    const flag: ExclusionDecision = {
      id: 'ex-flag',
      runId: 'run-0002',
      address: { chain: 'bitcoin', address: A.BTC1 },
      ruleId: 'A6',
      outcome: 'flagged',
      reason: 'A6: coinjoin-like transaction',
      evidence: {},
      rulesVersion: 'exclusion.v1',
    };
    const html = renderReport(withData((d) => d.exclusions.push(flag)));
    const links = sectionOf(html, 'powiazania');
    expect(links).toContain('id="powiazanie-link-btc1"');
    expect(links).toContain('Uwaga: reguła A6 oznaczyła adres do weryfikacji');
    const rejected = sectionOf(html, 'odrzucone');
    expect(rejected).not.toContain('id="odrzucony-ex-flag"');
    expect(rejected).toContain('Ostrzeżenia reguł (adresy nie są odrzucane)');
    expect(rejected).toContain('adres pozostaje powiązany (rozdział 3)');
    expect(sectionOf(html, 'podsumowanie')).toContain('Odrzucono 8 przypisań');
    expect(sectionOf(html, 'przeplywy')).toContain('(powiązany z „fikcyjny_kacper”, 99/100)');
  });

  it('claims a KYC lead only when analytics established authorship', () => {
    const withLead = renderReport(personaData());
    expect(sectionOf(withLead, 'odrzucone')).toContain('Trop KYC');
    const html = renderReport(
      withData((d) => {
        const a4 = d.exclusions.find((e) => e.ruleId === 'A4') as ExclusionDecision;
        a4.evidence = { txHashes: a4.evidence.txHashes ?? [], labelIds: a4.evidence.labelIds ?? [] };
      }),
    );
    expect(html).not.toContain('Trop KYC');
    const rejected = sectionOf(html, 'odrzucone');
    expect(rejected).toContain('Adres wymieniono w 1 wzmiance, ale nie potwierdzono, że opublikowała go osoba');
    expect(rejected).toContain('Autor wpisu według źródła: fikcyjny_kacper.');
    expect(rejected).toContain('Autora wzmianki nie ustalono.');
  });

  it("uses the scoring engine's band and path counting", () => {
    const html = renderReport(
      withData((d) => {
        const tron = d.links.find((l) => l.id === 'link-tron1') as LinkAssessment;
        tron.band = 'SREDNIE';
        tron.paths = [...tron.paths, { ...(tron.paths[0] as LinkAssessment['paths'][number]), counted: false }];
      }),
    );
    const card = sectionOf(html, 'powiazania');
    expect(card).toContain('<span class="score">66/100</span> <span class="band band-medium">ŚREDNIE</span>');
    expect(card).toContain('nieuwzględniona w wyniku — silniejsza ścieżka tego samego serwisu');
  });

  it('renders a cash-out event without a fetched transfer as a computed indicator', () => {
    const missing: CashOutEvent = {
      ...(personaData().cashOuts[1] as CashOutEvent),
      id: 'co-missing',
      address: { chain: 'evm:1', address: A.ETH2 },
      txHashes: ['0xmissing'],
      occurredAt: '2026-11-10T10:00:00.000Z',
    };
    const html = renderReport(withData((d) => d.cashOuts.push(missing)));
    const entry = flowEntry(html, '0xmissing');
    expect(entry).toContain('class="flow-step flow-indicator"');
    expect(entry).toContain('tej transakcji nie ma w danych blockchain pobranych w tym uruchomieniu');
    expect(entry).toContain('data-statement="obliczenia"');
    expect(entry).not.toContain('data-statement="fakty"');
    expect(entry).not.toContain('przesłano z adresu');
  });

  it('copies a flow-edge valuation only to exactly the same movement', () => {
    const html = renderReport(
      withData((d) => {
        const edge = d.flows[0] as ReportData['flows'][number];
        edge.amount = '0.02';
      }),
    );
    const entry = flowEntry(html, '0xfund01');
    expect(entry).toContain('Brak wyceny w PLN.');
    expect(entry).not.toContain('1535,73');
  });

  it('never shows unknown values as zero', () => {
    const none = renderReport(
      withData((d) => {
        for (const e of d.cashOuts) unprice(e);
        d.flows = [];
      }),
    );
    expect(sectionOf(none, 'podsumowanie')).toContain('wartość niedostępna (brak wycen w PLN)');
    expect(sectionOf(none, 'podsumowanie')).not.toContain(`0,00${NBSP}zł`);
    const partial = renderReport(withData((d) => unprice(d.cashOuts.find((e) => e.ruleId === 'B5') as CashOutEvent)));
    // The B5 window covers two separate TRON transfers: two unpriced movements.
    expect(sectionOf(partial, 'podsumowanie')).toContain(`1520,37${NBSP}zł — suma częściowa, bez wyceny: 2 przepływy`);
  });

  it('counts a movement behind several indicators once', () => {
    const b1 = personaData().cashOuts.find((e) => e.ruleId === 'B1') as CashOutEvent;
    const html = renderReport(withData((d) => d.cashOuts.push({ ...b1, id: 'co-b4', ruleId: 'B4' })));
    const summary = sectionOf(html, 'podsumowanie');
    // B1 and B4 share the sweep; B5 covers two transfers: three distinct movements.
    expect(summary).toContain('Wykryto 3 przesłanki wyjścia do walut tradycyjnych dotyczących 3 przepływów');
    expect(summary).toContain(`1${NBSP}236${NBSP}087,87${NBSP}zł`);
  });

  it("attaches a cash-out rule and value only to the event's own outgoing movement", () => {
    const html = renderReport(
      withData((d) => {
        // Same transaction as the B1 sweep: an incoming refund and a payment to another recipient.
        d.transfers.push(transferLike(d, '0xsweep01', A.HOT1, A.ETH1, '0.005'));
        d.transfers.push(transferLike(d, '0xsweep01', A.ETH1, A.FUNDER, '0.0042'));
      }),
    );
    for (const needle of [`0,005${NBSP}ETH przesłano`, `0,0042${NBSP}ETH przesłano`]) {
      const entry = flowEntry(html, needle);
      expect(entry).not.toContain('Reguła B1');
      expect(entry).not.toContain('Możliwe wyjście');
      expect(entry).not.toContain('1520,37');
    }
    const sweep = flowEntry(html, `0,0099${NBSP}ETH przesłano`);
    expect(sweep).toContain('Reguła B1');
    expect(sweep).toContain(`1520,37${NBSP}zł`);
    // Aggregated events attach per leg, each with its own value.
    const leg = flowEntry(html, 'tron-tx-1');
    expect(leg).toContain('Reguła B5');
    expect(leg).toContain(`617${NBSP}283,75${NBSP}zł`);
  });

  it('keeps an uncertain match as a separate computed indicator', () => {
    const b1 = personaData().cashOuts.find((e) => e.ruleId === 'B1') as CashOutEvent;
    const odd: CashOutEvent = { ...b1, id: 'co-odd', ruleId: 'B4', amount: '0.02' };
    delete odd.valuation;
    const html = renderReport(withData((d) => d.cashOuts.push(odd)));
    expect(flowEntry(html, `0,0099${NBSP}ETH przesłano`)).not.toContain('Reguła B4');
    const indicator = flowEntry(html, 'Reguła B4');
    expect(indicator).toContain('flow-indicator');
    expect(indicator).not.toContain('data-statement="fakty"');
  });

  it('reports an incomplete run prominently', () => {
    const html = renderReport(
      withData((d) => {
        d.captures.push({ ...(d.captures[4] as ReportData['captures'][number]), id: 'cap-err', status: 'error' });
        d.partialReasons = ['tron provider: timeout'];
      }),
    );
    const summary = sectionOf(html, 'podsumowanie');
    expect(summary).toContain('<p class="alert-box">Analiza niepełna: część źródeł była niedostępna — 2 strony');
    expect(summary).toContain(
      'bez dostępu do treści (GitHub, keybase); zgłoszone przez etapy analizy: tron provider: timeout',
    );
    expect(summary).toContain('Bez dostępu do treści: 2 strony');
    const meta = sectionOf(html, 'metryka');
    expect(meta).toContain('Kompletność analizy');
    expect(meta).toContain('zgłoszone przez etapy analizy: tron provider: timeout');
    const clean = renderReport(withData((d) => (d.captures = d.captures.filter((c) => c.status === 'ok'))));
    expect(clean).not.toContain('Analiza niepełna');
    expect(sectionOf(clean, 'metryka')).toContain('brak zgłoszonych braków w chwili generowania raportu');
    const partialRun = renderReport(
      withData((d) => {
        d.captures = d.captures.filter((c) => c.status === 'ok');
        d.run.status = 'partial';
      }),
    );
    expect(partialRun).toContain(
      'Analiza niepełna: część źródeł była niedostępna — uruchomienie zakończyło się jako częściowe',
    );
  });
});

/** Removes every PLN value from an event (single valuation, per-leg values and their sum). */
function unprice(e: CashOutEvent): void {
  delete e.valuation;
  const extra = e as CashOutEvent & { plnTotal?: string; components?: { valuation?: unknown }[] };
  delete extra.plnTotal;
  for (const c of extra.components ?? []) delete c.valuation;
}

function transferLike(d: ReportData, txHash: string, from: string, to: string, amount: string) {
  const base = d.transfers.find((t) => t.txHash === '0xsweep01') as ReportData['transfers'][number];
  return { ...base, txHash, from, to, amount, index: d.transfers.length + 1 };
}
