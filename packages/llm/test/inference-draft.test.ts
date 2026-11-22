import type { LlmClient, LlmRequest, LlmResult, ReportComputed, ReportFact, ReportModel } from '@olcys/core';
import { INFERENCE_DRAFT_TASK } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  buildDraftContext,
  draftInferences,
  getPrompt,
  inferenceDraftPromptV1,
  isLlmAllowed,
  type DraftInput,
  type InferenceDraftOutput,
} from '../src/index.ts';

const fact = (id: string, captureId: string, statement = `Fakt ${id}`): ReportFact => ({
  id,
  statement,
  captureId,
  url: 'https://example.org/x',
  collectedAt: '2026-11-21T10:00:00.000Z',
});
const computed = (id: string, basedOn: string[], score?: number, data: unknown = {}): ReportComputed => ({
  id,
  kind: score === undefined ? 'activity' : 'score',
  statement: `Wynik ${id}`,
  data: score === undefined ? data : { score },
  basedOn,
});

function model(facts: ReportFact[], results: ReportComputed[]): ReportModel {
  return { reportId: 'rep-1', facts, computed: results } as unknown as ReportModel;
}

const SOURCES: Record<string, string> = { 'cap-1': 'wykop', 'cap-2': 'telegram_preview', 'cap-3': 'wykop' };
const input = (m: ReportModel, over: Partial<DraftInput> = {}): DraftInput => ({
  model: m,
  runId: 'run-1',
  caseId: 'case-1',
  captureSource: (captureId) => {
    const sourceId = SOURCES[captureId];
    return sourceId && isLlmAllowed({ sourceId, url: 'https://example.org/x' }, { id: sourceId, llmAllowed: true })
      ? sourceId
      : undefined;
  },
  ...over,
});

const base = model(
  [fact('f1', 'cap-1'), fact('f2', 'cap-2', 'Wpis z Telegrama'), fact('f3', 'cap-3')],
  [
    computed('w-low', ['f1'], 40),
    computed('w-high', ['f3'], 90),
    computed('w-tg', ['f2'], 95),
    computed('w-tg-child', ['w-tg'], 10),
    computed('w-tg-child-valuation', [], undefined),
    computed('w-tg-child2', [], undefined, { captureId: 'cap-2' }),
  ],
);

function fakeLlm(drafts: InferenceDraftOutput['drafts'] | 'fail', enabled = true) {
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    enabled,
    async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push(request as LlmRequest);
      if (drafts === 'fail') return { ok: false, code: 'timeout', message: 'down', callId: 'call-0' };
      return { ok: true, output: request.parseOutput({ drafts }), callId: 'call-1', model: 'fake', modelDigest: 'abc' };
    },
  };
  return { client, requests };
}

const draft = (patch: Partial<InferenceDraftOutput['drafts'][number]> = {}) => ({
  statement: 'Adres może należeć do osoby; wymaga weryfikacji.',
  basedOn: ['W:w-high', 'F:f3'],
  alternatives: ['Adres mógł zostać opublikowany przez osobę trzecią.'],
  verificationSteps: ['Wystąpienie do dostawcy usług kryptoaktywów (VASP).'],
  ...patch,
});

describe('buildDraftContext', () => {
  it('lists results and facts, ordered by score then id, and leaves out Telegram-derived items', () => {
    const ctx = buildDraftContext(input(base));
    expect(ctx.text.split('\n')).toEqual([
      '[W:w-high] Wynik w-high',
      '[W:w-low] Wynik w-low',
      '[F:f1] Fakt f1',
      '[F:f3] Fakt f3',
    ]);
    // the Telegram fact, a score based on it, its children, a result with a Telegram capture and the valuation
    expect(ctx.excluded).toBe(5);
    expect(ctx.ids).toEqual(['W:w-high', 'W:w-low', 'F:f1', 'F:f3']);
    expect(ctx.inputs).toEqual([
      { captureId: 'cap-3', sourceId: 'wykop', llmAllowed: true },
      { captureId: 'cap-1', sourceId: 'wykop', llmAllowed: true },
    ]);
    expect(ctx.text).not.toContain('Telegram');
  });

  it('excludes a valuation of a Telegram-derived event', () => {
    const m = model(
      [fact('f2', 'cap-2')],
      [computed('co-1', ['f2'], undefined), computed('co-1-valuation', [], undefined)],
    );
    expect(buildDraftContext(input(m))).toMatchObject({ ids: [], excluded: 3 });
  });

  it('fits 500 facts into whole lines within the limit and is repeatable', () => {
    const facts = Array.from({ length: 500 }, (_, i) =>
      fact(`f${String(i).padStart(3, '0')}`, 'cap-1', `Obserwacja numer ${i} z długim opisem `.repeat(3)),
    );
    const m = model(facts, []);
    const a = buildDraftContext(input(m));
    const b = buildDraftContext(input(m));
    expect(a.text.length).toBeLessThanOrEqual(inferenceDraftPromptV1.maxInputChars);
    expect(a.text).toBe(b.text);
    expect(a.truncated).toBeGreaterThan(0);
    expect(a.text.split('\n').every((line) => /^\[F:f\d{3}\] Obserwacja numer \d+ /.test(line))).toBe(true);
    expect(a.ids).toHaveLength(a.text.split('\n').length);
  });
});

describe('draftInferences', () => {
  it('keeps valid drafts as pending-ready suggestions and drops unknown ids and restated scores', async () => {
    const { client, requests } = fakeLlm([
      draft(),
      draft({ basedOn: ['F:missing'] }),
      draft({ statement: 'Wskaźnik Pewności 99/100 wskazuje na to.' }),
      draft({ basedOn: ['F:f2'] }),
    ]);
    const outcome = await draftInferences(input(base), { llm: client });
    expect(outcome.status).toBe('drafted');
    if (outcome.status !== 'drafted') return;
    // the Telegram fact id was never offered, so a draft citing it is an unknown basis
    expect(outcome.dropped).toEqual({ unknownBasis: 2, restatesScore: 1 });
    expect(outcome.suggestions).toHaveLength(1);
    expect(outcome.suggestions[0]).toMatchObject({
      task: INFERENCE_DRAFT_TASK,
      runId: 'run-1',
      target: { reportId: 'rep-1' },
      label: 'draft',
      model: 'fake',
      promptVersion: 'v1',
      callId: 'call-1',
      output: { basedOn: ['w-high', 'f3'] },
    });
    // only A/B text is sent, as untrusted input, and it holds no Telegram text
    expect(requests[0]?.untrustedInput).not.toContain('Telegram');
    expect(requests[0]?.containsIdentifier).toBe(true);
  });

  it('returns typed outcomes for a disabled, failing or empty case', async () => {
    expect(await draftInferences(input(base), { llm: fakeLlm([], false).client })).toEqual({
      status: 'skipped',
      reason: 'llm_disabled',
    });
    expect(await draftInferences(input(base), { llm: fakeLlm('fail').client })).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
    const none = fakeLlm([]);
    expect(await draftInferences(input(model([fact('f2', 'cap-2')], [])), { llm: none.client })).toEqual({
      status: 'skipped',
      reason: 'nothing_to_draft',
    });
    expect(none.requests).toHaveLength(0);
  });
});

describe('report-inference-draft prompt', () => {
  it('is registered with a schema that enforces the bounds', () => {
    expect(getPrompt(INFERENCE_DRAFT_TASK, 'v1')).toBe(inferenceDraftPromptV1);
    const parse = (drafts: unknown) => inferenceDraftPromptV1.schema.safeParse({ drafts }).success;
    expect(parse([draft()])).toBe(true);
    expect(parse(Array.from({ length: 7 }, () => draft()))).toBe(false);
    expect(parse([draft({ basedOn: [] })])).toBe(false);
    expect(parse([draft({ basedOn: Array.from({ length: 11 }, (_, i) => `F:${i}`) })])).toBe(false);
    expect(parse([draft({ alternatives: [] })])).toBe(false);
    expect(parse([draft({ statement: 'x'.repeat(601) })])).toBe(false);
    expect(inferenceDraftPromptV1.system).toContain('UNTRUSTED_DATA');
  });
});
