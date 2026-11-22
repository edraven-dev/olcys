import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { classifyAddressMention } from '@olcys/llm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createLlmRuntime } from '../src/llm.ts';

// Opt-in smoke test against the model server on this machine: OLCYS_LLM_LIVE=1 (loopback only, one synthetic sentence).
const live = process.env['OLCYS_LLM_LIVE'] === '1';
const baseUrl = process.env['LLM_BASE_URL'] ?? 'http://localhost:2140/v3';
const model = process.env['LLM_MODEL'] ?? 'qwen3.6-35b-ov';

describe.skipIf(!live)('address role classifier against the local model (OLCYS_LLM_LIVE=1)', () => {
  it('suggests a role with a verbatim span for a synthetic Polish sentence', async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(baseUrl).hostname);
    const { client } = createLlmRuntime({
      env: {
        LLM_ENABLED: 'true',
        LLM_BASE_URL: baseUrl,
        LLM_MODEL: model,
        LLM_CHAT_TEMPLATE_KWARGS: process.env['LLM_CHAT_TEMPLATE_KWARGS'] ?? '{"enable_thinking":false}',
        LLM_TIMEOUT_MS: '120000',
      },
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      sources: (await loadConfig()).sources,
      mode: 'offline',
    });
    const address = '0x0000000000000000000000000000000000000001';
    const outcome = await classifyAddressMention(
      {
        candidate: {
          id: 'c1',
          address: { chain: 'evm:1', address },
          context: {
            snippet: `Uwaga, fikcyjny test: to jest mój prywatny portfel do wpłat ETH, adres ${address}. Dziękuję.`,
            inCode: false,
            roleCues: [],
            pageAddressDensity: 1,
            occurrencesInCapture: 1,
          },
        },
        capture: { id: 'cap1', sourceId: 'wykop', url: 'http://127.0.0.1/p', finalUrl: 'http://127.0.0.1/p' },
        source: { id: 'wykop', llmAllowed: true },
        runId: 'run1',
        caseId: 'case1',
      },
      { llm: client },
    );
    console.info(JSON.stringify(outcome));
    expect(outcome.status).toBe('suggested');
  }, 180_000);
});
