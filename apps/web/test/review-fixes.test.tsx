import type { AddressCandidate, Observation, RunWithProgress } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Async, resourceIssue } from '../src/components/ui.tsx';
import { submitCase } from '../src/features/cases/case-form.ts';
import { DecisionCard } from '../src/features/rejected/RejectedTab.tsx';
import { describeMentions } from '../src/features/rejected/rejected-model.ts';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { ApiRequestError } from '../src/lib/api.ts';
import type { Resource } from '../src/lib/use-api.ts';
import { capture, depositExclusion, ETH_1, RUN_ID } from './fixtures/persona.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const mention = (id: string, roleCues: AddressCandidate['context']['roleCues'], anchor?: string): AddressCandidate => ({
  id,
  captureId: capture.id,
  raw: ETH_1,
  address: { chain: 'evm:1', address: ETH_1 },
  format: 'evm_eip55',
  checksum: { scheme: 'eip55', present: true, valid: true, bits: 15 },
  chainAttribution: { method: 'keyword' },
  view: 'visible_text',
  span: { start: 0, end: 42 },
  transforms: [],
  context: {
    snippet: `Wpłata na ${ETH_1}`,
    inCode: false,
    roleCues,
    pageAddressDensity: 3,
    occurrencesInCapture: 1,
    ...(anchor ? { anchor } : {}),
  },
  reviewRequired: false,
});

const author = (value: string, msg: string): Observation => ({
  id: `obs-${msg}`,
  runId: RUN_ID,
  captureId: capture.id,
  sourceId: 'fixture_site',
  subject: { type: 'page', key: 'topic-5500002' },
  property: 'post.author',
  value,
  locator: `bitcointalk:msg=${msg}#post.author`,
  observedAt: capture.collectedAt,
});

const observations = [author('fikcyjny_kacper', '65000101'), author('test_moderator', '65000102')];
const subject = new Set(['fikcyjny_kacper']);
const captures = new Map([[capture.id, capture]]);
const scope = {
  run: { id: RUN_ID, caseId: 'case-1' } as RunWithProgress,
  kase: undefined,
  version: '',
} satisfies RunScope;

describe('mentions are described neutrally; the KYC lead comes only from the engine', () => {
  const own = mention('m-own', ['exchange_deposit'], 'msg65000101');
  const quoted = mention('m-quote', ['quote'], 'msg65000102');
  const warning = mention('m-warn', ['scam_report']);

  it('labels each mention with its author and marks third-party statements', () => {
    const views = describeMentions([own, quoted], observations, [], captures, subject);
    expect(views.map((v) => [v.author, v.thirdParty])).toEqual([
      ['fikcyjny_kacper', false],
      ['test_moderator', true],
    ]);
    const [unknown] = describeMentions([warning], [], [], captures, subject);
    expect(unknown).toMatchObject({ thirdParty: true });
    expect(unknown?.author).toBeUndefined();
  });

  it('does not claim the subject published the address without evidence.kycLead', () => {
    const mentions = describeMentions([quoted], observations, [], captures, subject);
    const html = renderToStaticMarkup(
      <ul>
        <DecisionCard
          decision={depositExclusion}
          labels={[]}
          mentions={mentions}
          captures={captures}
          cashOuts={[]}
          scope={scope}
        />
      </ul>,
    );
    const content = text(html);
    expect(content).not.toContain('Trop KYC');
    expect(content).toContain('Adres wspomniany w:');
    expect(content).toContain('Autor: test_moderator');
    expect(content).toContain('wzmianka strony trzeciej');
    expect(content).toContain('Sygnały kontekstu: cytat');
  });

  it('shows the KYC lead when the engine sets it', () => {
    const decision = { ...depositExclusion, evidence: { ...depositExclusion.evidence, kycLead: true } };
    const html = renderToStaticMarkup(
      <ul>
        <DecisionCard decision={decision} labels={[]} mentions={[]} captures={captures} cashOuts={[]} scope={scope} />
      </ul>,
    );
    expect(text(html)).toContain('Trop KYC: osoba sama opublikowała ten adres depozytowy');
  });
});

const renderAsync = (r: Resource<string[]>) =>
  text(
    renderToStaticMarkup(
      <Async resource={r} isEmpty={(l) => l.length === 0} emptyText="EMPTY">
        {(l) => <p>{l.join(',')}</p>}
      </Async>,
    ),
  );

describe('failed reads are never shown as current or empty data', () => {
  const at = Date.parse('2026-11-21T19:21:30Z');
  const network = new ApiRequestError(0, 'network', 'fetch failed');
  const resource = (data: string[] | undefined, error?: unknown): Resource<string[]> => ({
    data,
    error,
    loading: false,
    updatedAt: data ? at : undefined,
    reload() {},
  });
  it('classifies stale and unavailable resources', () => {
    expect(resourceIssue(resource(['a']))).toBeNull();
    expect(resourceIssue(resource(['a'], network))).toBe('stale');
    expect(resourceIssue(resource(undefined, network))).toBe('unavailable');
  });

  it('keeps old data visible with a warning, its time and a retry', () => {
    const content = renderAsync(resource(['stara wartość'], network));
    expect(content).toContain('Nie udało się odświeżyć danych — wyświetlane są dane z 21.11.2026, 20:21:30.');
    expect(content).toContain('Spróbuj ponownie');
    expect(content).toContain('stara wartość');
  });

  it('tells an unavailable section apart from an empty result', () => {
    const unavailable = renderAsync(resource(undefined, network));
    expect(unavailable).toContain('Sekcja niedostępna (błąd odczytu danych).');
    expect(unavailable).not.toContain('EMPTY');
    expect(renderAsync(resource([]))).toContain('EMPTY');
  });
});

describe('a failed run start never leads to a second case', () => {
  const body = {
    title: 'Sprawa syntetyczna',
    purpose: 'Test na danych syntetycznych',
    legalBasis: 'demonstracja',
    identifiers: [{ kind: 'nickname' as const, value: 'fikcyjny_kacper', isAnchor: true }],
    scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
  };

  it('keeps the created case id when starting the run fails and retries only the run', async () => {
    const createCase = vi.fn<(body: unknown) => Promise<{ id: string }>>(async () => ({ id: 'case-1' }));
    const startRun = vi
      .fn<(caseId: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new ApiRequestError(0, 'network', 'down'))
      .mockResolvedValueOnce({ id: 'run-1' });
    const first = await submitCase(body, true, undefined, { createCase, startRun });
    expect(first).toMatchObject({ caseId: 'case-1', error: expect.any(ApiRequestError) });
    const retry = await submitCase(body, true, first.caseId, { createCase, startRun });
    expect(retry).toEqual({ caseId: 'case-1', runId: 'run-1' });
    expect(createCase).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenLastCalledWith('case-1');
  });

  it('reports a failed creation without a case id', async () => {
    const outcome = await submitCase(body, true, undefined, {
      createCase: async () => {
        throw new ApiRequestError(400, 'invalid_input', 'bad');
      },
      startRun: async () => ({ id: 'never' }),
    });
    expect(outcome.caseId).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(ApiRequestError);
  });
});
