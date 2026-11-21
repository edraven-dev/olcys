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
        for (const e of d.cashOuts) delete e.valuation;
        d.flows = [];
      }),
    );
    expect(sectionOf(none, 'podsumowanie')).toContain('wartość niedostępna (brak wycen w PLN)');
    expect(sectionOf(none, 'podsumowanie')).not.toContain(`0,00${NBSP}zł`);
    const partial = renderReport(
      withData((d) => {
        delete (d.cashOuts.find((e) => e.ruleId === 'B5') as CashOutEvent).valuation;
      }),
    );
    // The unvalued B5 event covers two separate TRON transfers: two unpriced movements.
    expect(sectionOf(partial, 'podsumowanie')).toContain(`1520,37${NBSP}zł — suma częściowa, bez wyceny: 2 przepływy`);
  });

  it('counts a movement behind several indicators once', () => {
    const b1 = personaData().cashOuts.find((e) => e.ruleId === 'B1') as CashOutEvent;
    const html = renderReport(withData((d) => d.cashOuts.push({ ...b1, id: 'co-b4', ruleId: 'B4' })));
    const summary = sectionOf(html, 'podsumowanie');
    expect(summary).toContain('Wykryto 3 przesłanki wyjścia do walut tradycyjnych dotyczących 2 przepływów');
    expect(summary).toContain(`1${NBSP}236${NBSP}087,87${NBSP}zł`);
  });
});
