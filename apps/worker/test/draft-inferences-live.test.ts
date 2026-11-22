import type { ReportModel } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { draftInferences, isLlmAllowed } from '@olcys/llm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createLlmRuntime } from '../src/llm.ts';

// Opt-in smoke test against the model server on this machine: OLCYS_LLM_LIVE=1 (loopback only, synthetic report data).
const live = process.env['OLCYS_LLM_LIVE'] === '1';
const baseUrl = process.env['LLM_BASE_URL'] ?? 'http://localhost:2140/v3';
const model = process.env['LLM_MODEL'] ?? 'qwen3.6-35b-ov';

const at = '2026-11-21T10:00:00.000Z';
const fact = (id: string, captureId: string, statement: string) => ({
  id,
  statement,
  captureId,
  url: 'http://127.0.0.1:4100/x',
  collectedAt: at,
});

const synthetic = {
  reportId: 'rep-live',
  facts: [
    fact(
      'f-profile',
      'cap-forum',
      'Źródło Bitcointalk (fikcyjne): profil fikcyjny_kacper — pole „adres portfela”: bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2.',
    ),
    fact(
      'f-post',
      'cap-social',
      'Adres bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2 wystąpił na stronie http://127.0.0.1:4100/wykop/ludzie/fikcyjny_kacper (Wykop).',
    ),
    fact('f-telegram', 'cap-telegram', 'Wpis z Telegramu: ostrzeżenie przed fikcyjny_kacper.'),
  ],
  computed: [
    {
      id: 'w-score',
      kind: 'score',
      statement:
        'Powiązanie adresu bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2 (Bitcoin) z identyfikatorem „fikcyjny_kacper”: prawdopodobne (Wskaźnik Pewności 78/100, wysoki).',
      data: { score: 78 },
      basedOn: ['f-profile', 'f-post'],
    },
    {
      id: 'w-cashout',
      kind: 'cash_out',
      statement:
        'Reguła C1 — wpłata na giełdę (silna): 0.5 BTC z adresu bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2; odbiorca Giełda Fikcyjna.',
      data: {},
      basedOn: ['f-profile'],
    },
    {
      id: 'w-tg',
      kind: 'score',
      statement: 'Powiązanie z adresem z Telegramu.',
      data: { score: 90 },
      basedOn: ['f-telegram'],
    },
  ],
} as unknown as ReportModel;

describe.skipIf(!live)('draft inferences against the local model (OLCYS_LLM_LIVE=1)', () => {
  it('drafts hypotheses citing only ids it was shown, from synthetic report data', async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(baseUrl).hostname);
    const { sources } = await loadConfig();
    const { client } = createLlmRuntime({
      env: {
        LLM_ENABLED: 'true',
        LLM_BASE_URL: baseUrl,
        LLM_MODEL: model,
        LLM_CHAT_TEMPLATE_KWARGS: process.env['LLM_CHAT_TEMPLATE_KWARGS'] ?? '{"enable_thinking":false}',
        LLM_TIMEOUT_MS: '300000',
      },
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      sources,
      mode: 'offline',
    });
    const captures: Record<string, string> = {
      'cap-forum': 'bitcointalk',
      'cap-social': 'wykop',
      'cap-telegram': 'telegram_preview',
    };
    const outcome = await draftInferences(
      {
        model: synthetic,
        runId: 'run-live',
        caseId: 'case-live',
        captureSource(captureId) {
          const sourceId = captures[captureId];
          const source = sources.find((s) => s.id === sourceId);
          const url = 'http://127.0.0.1:4100/x';
          return sourceId && isLlmAllowed({ sourceId, url, finalUrl: url }, source) ? sourceId : undefined;
        },
      },
      { llm: client },
    );
    console.info(JSON.stringify(outcome, null, 1));
    expect(outcome.status).toBe('drafted');
    if (outcome.status !== 'drafted') return;
    expect(outcome.excluded).toBe(2);
    for (const s of outcome.suggestions) {
      const o = s.output as { basedOn: string[] };
      expect(o.basedOn.every((id) => ['w-score', 'w-cashout', 'f-profile', 'f-post'].includes(id))).toBe(true);
    }
  }, 360_000);
});
