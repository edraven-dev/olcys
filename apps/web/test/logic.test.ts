import { renderPartialReason } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { nbpLine, transfersFor, addressOptions } from '../src/features/activity/activity-model.ts';
import {
  buildCreateCaseRequest,
  errorsFromIssues,
  initialFormState,
  newIdentifierRow,
  validateCaseForm,
} from '../src/features/cases/case-form.ts';
import { diffParts, groupChanges } from '../src/features/changes/changes-model.ts';
import {
  evidenceRefs,
  isAnchorHop,
  synergyOf,
  waterfallBars,
  waterfallDomain,
} from '../src/features/links/score-model.ts';
import {
  nonAsciiCodepoints,
  reasonCode,
  rejectedCandidates,
  splitNonAscii,
} from '../src/features/rejected/rejected-model.ts';
import {
  egressSummary,
  partialReasons,
  progressCounters,
  stepStates,
  summariseSources,
} from '../src/features/run/run-model.ts';
import { pl } from '../src/i18n/pl.ts';
import { bandForScore, resolveBand } from '../src/lib/band.ts';
import { isRejectedLink, isWalletSwap, isWeakIdentity, linkBand, type SourceItem } from '../src/lib/domain.ts';
import { parseRoute, routePath } from '../src/lib/router.tsx';
import {
  accounts,
  anchorHop,
  btcAddressHop,
  btcLink,
  capture,
  D3_HOMOGLYPH,
  depositExclusion,
  ETH_1,
  ethWeakLink,
  thirdPartyLink,
  tronLink,
  walletSwap,
} from './fixtures/persona.ts';

describe('score bands (cheat sheet)', () => {
  it('maps scores to bands', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 10, 9, 0].map((s) => bandForScore(s))).toEqual([
      'BARDZO_WYSOKIE',
      'BARDZO_WYSOKIE',
      'PRAWDOPODOBNE',
      'PRAWDOPODOBNE',
      'SREDNIE',
      'SREDNIE',
      'NISKIE',
      'NISKIE',
      'NISKIE',
      'NISKIE',
    ]);
    expect(bandForScore(97, true)).toBe('WYKLUCZENIE');
  });

  it('prefers the engine band and computes it only when missing or invalid', () => {
    expect(resolveBand({ score: 99, band: 'SREDNIE' })).toBe('SREDNIE');
    expect(resolveBand({ score: 99 })).toBe('BARDZO_WYSOKIE');
    expect(resolveBand({ score: 99, band: 'bogus' })).toBe('BARDZO_WYSOKIE');
  });

  it('treats non-ownership relations, failed hard gates and exclusions as WYKLUCZENIE', () => {
    expect(linkBand(btcLink)).toBe('BARDZO_WYSOKIE');
    expect(linkBand(tronLink)).toBe('SREDNIE');
    expect(linkBand(ethWeakLink)).toBe('NISKIE');
    expect(isRejectedLink(thirdPartyLink)).toBe(true);
    expect(linkBand(thirdPartyLink)).toBe('WYKLUCZENIE');
    expect(isRejectedLink(btcLink, new Set([`bitcoin:${btcLink.address.address}`]))).toBe(true);
    expect(isRejectedLink({ ...btcLink, gates: [{ gate: 'exclusion', passed: false }] })).toBe(true);
    expect(isRejectedLink({ ...btcLink, gates: [{ gate: 'review_required', passed: false }] })).toBe(false);
  });

  it('flags weak identity links (every identity hop below 0.5)', () => {
    expect(isWeakIdentity(ethWeakLink)).toBe(true);
    expect(isWeakIdentity(btcLink)).toBe(false);
  });
});

describe('waterfall and synergy', () => {
  it('builds prior → contributions → total, keeping superseded items at zero length', () => {
    const bars = waterfallBars(btcAddressHop);
    expect(bars.map((b) => b.kind)).toEqual(['prior', 'feature', 'feature', 'feature', 'total']);
    expect(bars[0]).toMatchObject({ start: 0, end: -2 });
    expect(bars[1]?.end).toBeCloseTo(-2 + 9.8919, 3);
    expect(bars[2]?.end).toBeCloseTo(-2 + 9.8919 + 4.6893, 3);
    const superseded = bars[3];
    expect(superseded?.counted).toBe(false);
    expect(superseded?.start).toBe(superseded?.end);
    expect(bars[4]?.end).toBeCloseTo(12.5812, 3);
    const [min, max] = waterfallDomain(bars);
    expect(min).toBeLessThan(-2);
    expect(max).toBeGreaterThan(12.58);
  });

  it('renders the anchor identity hop as one assumption bar', () => {
    expect(isAnchorHop(anchorHop)).toBe(true);
    expect(waterfallBars(anchorHop)).toEqual([expect.objectContaining({ kind: 'anchor', end: Math.log2(99) })]);
  });

  it('derives trace synergy from independent services when the engine does not send it', () => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(synergyOf(tronLink, byId)).toEqual({
      independentSources: ['tablica', 'wykop'],
      bestSingleScore: 40,
      bonusPoints: 18,
      repeatedPaths: 0,
      repeatedItems: 0,
    });
    const repeated = { ...tronLink, paths: tronLink.paths.map((p, i) => ({ ...p, counted: i === 0 })) };
    expect(synergyOf(repeated, byId).independentSources).toEqual(['wykop']);
    expect(synergyOf(repeated, byId).repeatedPaths).toBe(1);
    const engine = {
      independentSources: ['a', 'b'],
      bestSingleScore: 50,
      bonusPoints: 8,
      repeatedPaths: 0,
      repeatedItems: 2,
    };
    expect(synergyOf({ ...tronLink, synergy: engine }, byId)).toBe(engine);
    expect(synergyOf(btcLink, byId).repeatedItems).toBe(1);
  });

  it('collects the evidence behind a link', () => {
    expect(evidenceRefs(btcLink).captureIds).toEqual([capture.id]);
  });
});

describe('rejected addresses', () => {
  it('exposes homoglyphs and reason codes', () => {
    expect(nonAsciiCodepoints(D3_HOMOGLYPH)).toEqual(['U+0430']);
    expect(nonAsciiCodepoints('bc1qqeyyk5')).toEqual([]);
    expect(splitNonAscii('abаc').map((p) => [p.text, p.nonAscii, p.offset])).toEqual([
      ['ab', false, 0],
      ['а', true, 2],
      ['c', false, 3],
    ]);
    expect(reasonCode('checksum_invalid: bad bech32')).toBe('checksum_invalid');
    expect(reasonCode('homoglyph_detected')).toBe('homoglyph_detected');
  });

  it('lists matches rejected at validation once per capture', () => {
    const rejected = {
      raw: D3_HOMOGLYPH,
      reason: 'homoglyph_detected',
      view: 'visible_text' as const,
      span: { start: 0, end: 42 },
    };
    const result = {
      captureId: 'c1',
      candidates: [],
      rejected: [rejected, rejected],
      secrets: [],
      extractorVersion: 'x',
    };
    expect(rejectedCandidates([result])).toHaveLength(1);
  });
});

describe('changes', () => {
  it('raises a wallet swap as an alert and keeps other value changes in their group', () => {
    const linkChange = {
      ...walletSwap,
      id: 'chg-2',
      wallet: false,
      key: { ...walletSwap.key, property: 'profile.link' },
    };
    const { alerts, byKind } = groupChanges([walletSwap, linkChange]);
    expect(alerts.map((c) => c.id)).toEqual(['chg-1']);
    expect(byKind.VALUE_CHANGED.map((c) => c.id)).toEqual(['chg-2']);
    const withoutFlag = { ...walletSwap, wallet: undefined };
    expect(isWalletSwap(withoutFlag)).toBe(true);
    expect(isWalletSwap({ ...withoutFlag, kind: 'ADDED' })).toBe(false);
  });

  it('marks the differing middle of a swapped value', () => {
    const parts = diffParts('bc1qAAAxyz', 'bc1qBBxyz');
    expect(parts.before.map((p) => [p.text, p.changed])).toEqual([
      ['bc1q', false],
      ['AAA', true],
      ['xyz', false],
    ]);
    expect(parts.after.find((p) => p.changed)?.text).toBe('BB');
  });
});

const transfer = (txHash: string, from: string, to: string, blockTime: string) => ({
  chain: 'evm:1' as const,
  txHash,
  blockHeight: 1,
  blockTime,
  from,
  to,
  asset: { chain: 'evm:1' as const, symbol: 'ETH', decimals: 18 },
  amount: '0.01',
  kind: 'native' as const,
  fetchId: 'f',
});

const indicator = (chain: 'evm:1' | 'bitcoin', address: string) => ({
  address: { chain, address },
  window: {},
  txCount: 1,
  volumeIn: { native: '0' },
  volumeOut: { native: '0' },
  counterpartyCount: 0,
  serviceInteractions: [],
  swaps: [],
  cashOut: { events: [], score: 0 },
  computedAt: '2026-11-21T00:00:00Z',
  rulesVersion: 'cashout.v1',
});

describe('activity', () => {
  it('describes the NBP rate behind a PLN value', () => {
    const line = nbpLine({
      nbp: { table: '226/A/NBP/2026', effectiveDate: '2026-11-19', currency: 'USD', rate: '3.6512' },
    });
    expect(line).toBe('kurs średni NBP, tabela 226/A/NBP/2026 z dnia 2026-11-19: 1 USD = 3,6512 zł');
  });

  it('lists transfers of an address oldest first (EVM case-insensitive)', () => {
    const rows = transfersFor({ chain: 'evm:1', address: ETH_1 }, [
      transfer('0x2', ETH_1.toUpperCase().replace('0X', '0x'), '0xhot', '2026-10-15T10:00:00Z'),
      transfer('0x1', '0xfunder', ETH_1, '2026-10-14T10:00:00Z'),
      transfer('0x3', '0xa', '0xb', '2026-10-16T10:00:00Z'),
    ]);
    expect(rows.map((r) => [r.txHash, r.direction])).toEqual([
      ['0x1', 'in'],
      ['0x2', 'out'],
    ]);
  });

  it('labels the address selector with relation and score, or the rejecting rule', () => {
    const options = addressOptions(
      [indicator('bitcoin', btcLink.address.address), indicator('evm:1', ETH_1)],
      [btcLink],
      [depositExclusion],
    );
    expect(options[0]?.label).toContain('Wskaźnik Pewności 99');
    expect(options[1]?.label).toContain('reguła A4');
  });
});

describe('new-case form', () => {
  const sources: SourceItem[] = [
    {
      id: 'fixture_site',
      name: 'Strona testowa',
      kind: 'fixture',
      compliance: 'GREEN',
      complianceNote: 'x',
      enabledByDefault: true,
      sendsIdentifiersExternally: false,
    },
    {
      id: 'bitcointalk',
      name: 'Bitcointalk',
      kind: 'forum',
      compliance: 'AMBER',
      complianceNote: 'x',
      enabledByDefault: false,
      sendsIdentifiersExternally: true,
    },
    {
      id: 'x_twitter',
      name: 'X',
      kind: 'social',
      compliance: 'RED',
      complianceNote: 'x',
      enabledByDefault: false,
      sendsIdentifiersExternally: true,
    },
  ];
  const filled = () => {
    const state = initialFormState(sources);
    state.title = 'Kacper Fikcyjny (dane syntetyczne)';
    state.purpose = 'Weryfikacja przychodów z kryptowalut — dane syntetyczne';
    state.legalBasis = 'art. 1 ustawy (przykład)';
    state.identifiers = [
      { ...newIdentifierRow('full_name'), value: 'Kacper Fikcyjny' },
      { ...newIdentifierRow('nickname'), value: ' fikcyjny_kacper ', platform: 'bitcointalk', isAnchor: true },
      { ...newIdentifierRow('email'), value: 'kacper.fikcyjny@example.org' },
    ];
    state.minimisation = true;
    return state;
  };

  it('pre-enables GREEN defaults and requires an AMBER justification of 20 characters', () => {
    const state = filled();
    expect(state.enabled).toEqual({ fixture_site: true });
    expect(validateCaseForm(state, sources)).toEqual({});
    state.enabled['bitcointalk'] = true;
    expect(validateCaseForm(state, sources)['source.bitcointalk']).toBe(pl.errors.amber_justification_required);
    state.justifications['bitcointalk'] = 'x'.repeat(19);
    expect(validateCaseForm(state, sources)['source.bitcointalk']).toBe(
      'Uzasadnienie jest za krótkie (minimum 20 znaków).',
    );
    state.justifications['bitcointalk'] = 'Demonstracja na danych syntetycznych — strona testowa';
    expect(validateCaseForm(state, sources)).toEqual({});
  });

  it('never sends a RED source and omits empty optional fields', () => {
    const state = filled();
    state.enabled['x_twitter'] = true;
    state.enabled['bitcointalk'] = true;
    state.justifications['bitcointalk'] = '  Demonstracja na danych syntetycznych  ';
    const body = buildCreateCaseRequest(state, sources);
    expect(body.scope.enabledSources).toEqual(['fixture_site', 'bitcointalk']);
    expect(body.scope.amberJustifications).toEqual({ bitcointalk: 'Demonstracja na danych syntetycznych' });
    expect(body.scope.chains).toEqual(['bitcoin', 'evm:1', 'tron']);
    expect(body.scope.maxPivotDepth).toBe(2);
    expect(body.identifiers).toEqual([
      { kind: 'full_name', value: 'Kacper Fikcyjny', isAnchor: false },
      { kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true },
      { kind: 'email', value: 'kacper.fikcyjny@example.org', isAnchor: false },
    ]);
  });

  it('validates required fields, e-mail, chain and minimisation', () => {
    const state = initialFormState(sources);
    state.identifiers = [
      { ...newIdentifierRow('crypto_address'), value: 'bc1q' },
      { ...newIdentifierRow('email'), value: 'zly-adres' },
    ];
    const errors = validateCaseForm(state, sources);
    expect(errors['title']).toBe(pl.errors.required);
    expect(errors['identifiers.0.chain']).toBe(pl.errors.chain_required);
    expect(errors['identifiers.1.value']).toBe(pl.errors.invalid_email);
    expect(errors['minimisation']).toBe(pl.errors.minimisation_required);
  });

  it('maps server validation issues to fields without exposing the English message', () => {
    const errors = errorsFromIssues([{ path: 'scope.amberJustifications.github', message: 'Too small' }]);
    expect(errors['source.github']).toBe('Serwer odrzucił wartość pola (scope.amberJustifications.github).');
  });
});

describe('run overview', () => {
  it('renders coded partial reasons in Polish and falls back to the raw text for unknown codes', () => {
    const progress = {
      partial: ['chain data incomplete for 2 address(es): tron timeout (2)', 'tron provider: timeout', 'x'],
      partialCodes: [
        {
          text: 'chain data incomplete for 2 address(es): tron timeout (2)',
          code: 'chain_incomplete',
          params: { count: 2, details: 'tron timeout (2)' },
        },
        { text: 'x', code: 'code_from_the_future' },
      ],
    };
    const text = partialReasons({ progress }).map((r) => renderPartialReason(r, pl.overview.partialReasons));
    expect(text).toEqual([
      'niepełna historia łańcucha dla 2 adresów (tron timeout (2))',
      'tron provider: timeout',
      'x',
    ]);
  });

  it('derives step states from the progress record', () => {
    const states = stepStates({ status: 'running', progress: { step: 'chain.fetch', done: 3, total: 6 } });
    expect(states['collect.source']).toBe('done');
    expect(states['chain.fetch']).toBe('running');
    expect(states['score.links']).toBe('pending');
    expect(stepStates({ status: 'failed', progress: { step: 'score.links' } })['score.links']).toBe('failed');
    expect(Object.values(stepStates({ status: 'succeeded', progress: {} }))).toEqual(Array(12).fill('done'));
    expect(progressCounters({ progress: { step: 'x', done: 1, total: 2, captures: 5, partial: [] } })).toEqual([
      ['captures', 5],
    ]);
  });

  it('keeps blocked sources apart from "not found"', () => {
    const blocked = { ...capture, id: 'c2', sourceId: 'bitcointalk', status: 'blocked' as const };
    const missing = { ...capture, id: 'c3', sourceId: 'keybase', status: 'not_found' as const };
    const summary = summariseSources([capture, blocked, missing], []);
    expect(summary.filter((s) => s.unavailable).map((s) => s.sourceId)).toEqual(['bitcointalk']);
    const egress = [
      {
        id: 'e1',
        sourceId: 'x',
        host: 'a',
        method: 'GET' as const,
        urlRedacted: '',
        purpose: '',
        containsIdentifier: true,
        allowed: true,
        mode: 'offline' as const,
        at: '',
      },
      {
        id: 'e2',
        sourceId: 'x',
        host: 'b',
        method: 'GET' as const,
        urlRedacted: '',
        purpose: '',
        containsIdentifier: false,
        allowed: false,
        mode: 'offline' as const,
        at: '',
      },
    ];
    expect(egressSummary(egress)).toEqual({ hosts: 2, total: 2, disclosed: 1, denied: 1 });
  });
});

describe('routes', () => {
  it('round-trips Polish paths', () => {
    const run = { name: 'run' as const, caseId: 'c-1', runId: 'r-1', tab: 'rejected' as const };
    expect(routePath(run)).toBe('/sprawy/c-1/przebiegi/r-1/odrzucone');
    expect(parseRoute('/sprawy/c-1/przebiegi/r-1/odrzucone')).toEqual(run);
    expect(parseRoute('/sprawy/c-1/przebiegi/r-1')).toMatchObject({ tab: 'overview' });
    expect(parseRoute('/sprawy/nowa')).toEqual({ name: 'newCase' });
    expect(parseRoute('/sprawy/c-1')).toEqual({ name: 'case', caseId: 'c-1' });
    expect(parseRoute('/')).toEqual({ name: 'cases' });
    expect(parseRoute('/inne')).toEqual({ name: 'notFound' });
    expect(parseRoute('/sprawy/c-1/przebiegi/r-1/nieznana')).toEqual({ name: 'notFound' });
  });
});
