/** Analyst judgements and overrides in the console: value lists in step with core, pure helpers, rendered forms. */
import type { AddressCandidate, AnalystJudgement, AnalystOverride, Observation, RunWithProgress } from '@olcys/core';
import {
  ADD_EVIDENCE_FEATURES,
  ADD_EVIDENCE_HOPS,
  ANALYST_OVERRIDE_KINDS,
  JUDGEMENT_VALUES,
  JUSTIFICATION_LENGTH,
  REVIEW_DECISIONS,
} from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  accountTargets,
  appliedIn,
  currentJudgement,
  EVIDENCE_FEATURE_HOPS,
  EVIDENCE_FEATURES,
  gradeTargets,
  JUDGEMENT_OPTIONS,
  JUSTIFICATION,
  justificationError,
  mergeJudgements,
  OVERRIDE_KINDS,
  overrideRequest,
  REVIEW_OPTIONS,
  reviewTargets,
  sortJudgements,
} from '../src/features/links/analyst-model.ts';
import { CaseOverrides } from '../src/features/links/AnalystPanel.tsx';
import { LinkCard } from '../src/features/links/LinksTab.tsx';
import { pl } from '../src/i18n/pl.ts';
import type { LinkView } from '../src/lib/domain.ts';
import type { Resource } from '../src/lib/use-api.ts';
import { accounts, btcLink, capture, identity, RUN_ID, tronLink, TRON_1 } from './fixtures/persona.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const btcLinkConfig = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: 'a'.repeat(64),
  weightsVersion: 'weights.v2',
  weightsSha256: 'c'.repeat(64),
  rulesVersions: {},
};

const observation: Observation = {
  id: 'obs-wallet',
  runId: RUN_ID,
  captureId: capture.id,
  sourceId: 'fixture_site',
  subject: { type: 'account', key: 'bitcointalk:900001' },
  property: 'profile.bitcoin_address',
  value: 'bc1q-synthetic',
  locator: 'bitcointalk:u=900001#profile.bitcoin_address',
  observedAt: '2026-11-21T19:21:30.000Z',
};
const repaired: AddressCandidate = {
  id: 'cand-repaired',
  captureId: capture.id,
  raw: btcLink.address.address,
  address: btcLink.address,
  format: 'p2wpkh',
  checksum: { scheme: 'bech32', present: true, valid: true, bits: 30 },
  chainAttribution: { method: 'format_unique' },
  view: 'visible_text',
  span: { start: 0, end: 42 },
  transforms: ['gap_joined'],
  context: {
    snippet: '(SYNTHETIC)',
    inCode: false,
    roleCues: ['unclear'],
    pageAddressDensity: 1,
    occurrencesInCapture: 1,
  },
  reviewRequired: true,
};

/** BTC-1 with an observation and a repaired candidate behind its first address item. */
const graded: LinkView = {
  ...btcLink,
  paths: btcLink.paths.map((p, i) =>
    i > 0
      ? p
      : {
          ...p,
          addressHop: {
            ...p.addressHop,
            contributions: p.addressHop.contributions.map((c, j) =>
              j === 0
                ? Object.assign({}, c, {
                    evidence: { ...c.evidence, observationId: observation.id, candidateId: repaired.id },
                  })
                : c,
            ),
          },
        },
  ),
};

const config = (ids?: string[]) => ({ ...btcLinkConfig, ...(ids ? { analystOverrides: ids } : {}) });

const ctx = {
  identities: new Map([[identity.id, identity]]),
  accounts: new Map(accounts.map((a) => [a.id, a])),
  captures: new Map([[capture.id, capture]]),
  observations: new Map([[observation.id, observation]]),
  candidates: new Map([[repaired.id, repaired]]),
  sourceNames: new Map([['fixture_site', 'Strona testowa']]),
};

const judgement = (id: string, value: AnalystJudgement['judgement'], at: string): AnalystJudgement => ({
  id,
  linkAssessmentId: btcLink.id,
  judgement: value,
  justification: `Uzasadnienie ${value} (test)`,
  analyst: 'Analityk Testowy',
  at,
});

const override = (id: string, at: string): AnalystOverride => ({
  id,
  caseId: 'case-1',
  kind: 'reliability_grade',
  target: { observationId: observation.id },
  value: 'B',
  justification: 'Ocena obserwacji (test)',
  analyst: 'Analityk Testowy',
  at,
});

describe('analyst value lists and catalogue', () => {
  it('mirror the core lists', () => {
    expect(JUDGEMENT_OPTIONS).toEqual([...JUDGEMENT_VALUES]);
    expect(OVERRIDE_KINDS).toEqual([...ANALYST_OVERRIDE_KINDS]);
    expect(REVIEW_OPTIONS).toEqual([...REVIEW_DECISIONS]);
    expect(EVIDENCE_FEATURES).toEqual([...ADD_EVIDENCE_FEATURES]);
    expect(EVIDENCE_FEATURE_HOPS).toEqual(ADD_EVIDENCE_HOPS);
    expect(JUSTIFICATION).toEqual(JUSTIFICATION_LENGTH);
  });

  it('labels every value and every error code of the analyst routes', () => {
    expect(Object.keys(pl.judgement.values)).toEqual([...JUDGEMENT_VALUES]);
    expect(Object.keys(pl.overrides.kinds)).toEqual([...ANALYST_OVERRIDE_KINDS]);
    for (const feature of ADD_EVIDENCE_FEATURES) expect(pl.features[feature]).toBeTruthy();
    for (const code of [
      'justification_too_short',
      'justification_too_long',
      'link_not_found',
      'feature_not_allowed',
      'grade_not_allowed',
      'invalid_value',
      'invalid_target',
      'target_not_found',
      'candidate_not_review_required',
      'run_not_finished',
    ]) {
      expect(pl.judgement.errors[code]).toBeTruthy();
    }
    expect(pl.judgement.errors['justification_too_short']).toBe('Uzasadnienie musi mieć co najmniej 10 znaków.');
    expect(pl.overrides.notice).toBe('Korekta analityka — zostanie uwzględniona dopiero po ponownej ocenie (rescore)');
  });
});

describe('analyst helpers', () => {
  it('checks the justification like the API (trimmed, 10–2000 characters)', () => {
    expect(justificationError('123456789')).toBe('justification_too_short');
    expect(justificationError('   1234567890   ')).toBeUndefined();
    expect(justificationError('x'.repeat(2001))).toBe('justification_too_long');
  });

  it('orders judgements oldest first; the latest is current', () => {
    const a = judgement('j-1', 'same', '2026-11-21T10:00:00.000Z');
    const b = judgement('j-2', 'not_same', '2026-11-21T11:00:00.000Z');
    expect(sortJudgements([b, a])).toEqual([a, b]);
    expect(currentJudgement([b, a])).toBe(b);
    expect(currentJudgement([])).toBeUndefined();
  });

  it('follows the refreshed judgements and keeps a judgement saved here until the refresh contains it', () => {
    const a = judgement('j-1', 'same', '2026-11-21T10:00:00.000Z');
    const saved = judgement('j-2', 'not_same', '2026-11-21T11:00:00.000Z');
    const later = judgement('j-3', 'unsure', '2026-11-21T12:00:00.000Z');
    // A stale (cached) list: the saved judgement still shows.
    expect(mergeJudgements([a], [saved])).toEqual([a, saved]);
    // The refreshed list contains it (and a newer one from elsewhere): shown once, in order.
    expect(mergeJudgements([later, saved, a], [saved])).toEqual([a, saved, later]);
    expect(mergeJudgements([], [])).toEqual([]);
  });

  it('offers the observations, candidates, sources and accounts behind a link', () => {
    expect(gradeTargets(graded, ctx).map((o) => o.key)).toEqual([
      'observation:obs-wallet',
      'candidate:cand-repaired',
      'source:fixture_site',
    ]);
    expect(reviewTargets(graded, ctx).map((o) => o.key)).toEqual(['candidate:cand-repaired']);
    expect(accountTargets(tronLink, ctx).map((o) => o.key)).toEqual(['account:acc-wykop', 'account:acc-tablica']);
  });

  it('adds the address to address-hop evidence only and trims the justification', () => {
    const base = {
      kind: 'add_evidence' as const,
      target: { accountId: 'acc-wykop' },
      justification: ' Uzasadnienie testowe ',
    };
    expect(overrideRequest(tronLink, { ...base, value: 'onchain_consistency' })).toEqual({
      kind: 'add_evidence',
      target: { accountId: 'acc-wykop', address: { chain: 'tron', address: TRON_1 } },
      value: 'onchain_consistency',
      justification: 'Uzasadnienie testowe',
    });
    expect(overrideRequest(tronLink, { ...base, value: 'contradicting_attribute' }).target).toEqual({
      accountId: 'acc-wykop',
    });
  });

  it('an override counts as applied only when the rescore recorded it when it was queued', () => {
    expect(appliedIn({ trigger: 'rescore', config: config(['o-1']) }, { id: 'o-1' })).toBe(true);
    expect(appliedIn({ trigger: 'rescore', config: config(['o-1']) }, { id: 'o-2' })).toBe(false);
    expect(appliedIn({ trigger: 'rescore', config: config() }, { id: 'o-1' })).toBe(false);
    expect(appliedIn({ trigger: 'manual', config: config(['o-1']) }, { id: 'o-1' })).toBe(false);
  });
});

describe('analyst forms', () => {
  const analyst = { enabled: true, caseId: 'case-1' };

  it('offers the judgement and override forms next to an unchanged score when enabled', () => {
    const content = text(
      renderToStaticMarkup(<LinkCard link={graded} ctx={ctx} excluded={new Set()} analyst={analyst} />),
    );
    expect(content).toContain('99 /100');
    expect(content).toContain('Ocena analityka');
    expect(content).toContain('Ocena jest zapisywana obok wyniku i nie zmienia obliczonego Wskaźnika Pewności.');
    for (const label of Object.values(pl.judgement.values)) expect(content).toContain(label);
    expect(content).toContain('Zapisz ocenę');
    expect(content).toContain('Korekta analityka — zostanie uwzględniona dopiero po ponownej ocenie (rescore)');
    expect(content).toContain('Zapisz korektę');
  });

  it('shows recorded judgements read-only when the feature is off, and nothing when there are none', () => {
    const judged: LinkView = {
      ...btcLink,
      judgements: [
        judgement('j-2', 'not_same', '2026-11-21T11:00:00.000Z'),
        judgement('j-1', 'unsure', '2026-11-21T10:00:00.000Z'),
      ],
    };
    const content = text(renderToStaticMarkup(<LinkCard link={judged} ctx={ctx} excluded={new Set()} />));
    expect(content).toContain('Aktualna ocena: Powiązanie odrzucone');
    expect(content).toContain('Analityk Testowy');
    expect(content).not.toContain('Zapisz ocenę');
    expect(content).toContain('99 /100');
    const none = text(renderToStaticMarkup(<LinkCard link={btcLink} ctx={ctx} excluded={new Set()} />));
    expect(none).not.toContain('Ocena analityka');
    expect(none).not.toContain('Korekta analityka');
  });

  it('lists the case overrides with whether this run applied them', () => {
    const resource: Resource<AnalystOverride[]> = {
      data: [override('o-1', '2026-11-21T09:00:00.000Z'), override('o-2', '2026-11-21T11:00:00.000Z')],
      error: undefined,
      loading: false,
      reload() {},
    };
    const run = {
      id: RUN_ID,
      caseId: 'case-1',
      trigger: 'rescore',
      status: 'succeeded',
      queuedAt: '2026-11-21T10:00:00.000Z',
      config: { ...btcLinkConfig, analystOverrides: ['o-1'] },
    };
    const content = text(
      renderToStaticMarkup(<CaseOverrides run={run as RunWithProgress} overrides={resource} ctx={ctx} />),
    );
    expect(content).toContain('Korekty analityka w sprawie');
    expect(content).toContain('uwzględniona w tym przebiegu');
    expect(content).toContain('oczekuje na ponowną ocenę');
    expect(content).toContain('Obserwacja: profile.bitcoin_address (Strona testowa)');
    expect(content).toContain('Uruchom ponowną ocenę (rescore)');
  });
});
