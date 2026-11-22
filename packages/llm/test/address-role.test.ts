import type { AddressCandidate, LlmClient, LlmRequest, LlmResult } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  addressRolePromptV1,
  classifyAddressMention,
  getPrompt,
  isLlmAllowed,
  lexiconAgreement,
  type AddressRoleOutput,
  type RoleClassificationInput,
} from '../src/index.ts';

const ADDRESS = 'TXyz1111111111111111111111111111111';
const SNIPPET = 'Cześć wszystkim, mój portfel USDT TRC20: TXyz1111111111111111111111111111111 — dziękuję za wsparcie.';

function fakeLlm(answer: Partial<AddressRoleOutput> | 'fail', enabled = true) {
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    enabled,
    async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push(request as LlmRequest);
      if (answer === 'fail') return { ok: false, code: 'timeout', message: 'down', callId: 'call-0' };
      const output = request.parseOutput({
        role: 'first_person_owner',
        evidenceSpan: 'mój portfel USDT TRC20',
        rationale: 'Autor nazywa adres swoim portfelem.',
        confidence: 'high',
        ...answer,
      });
      return { ok: true, output, callId: 'call-1', model: 'fake-model', modelDigest: 'abc' };
    },
  };
  return { client, requests };
}

const input = (over: Partial<RoleClassificationInput> = {}): RoleClassificationInput => ({
  candidate: {
    id: 'cand-1',
    address: { chain: 'tron', address: ADDRESS },
    context: { snippet: SNIPPET, inCode: false, roleCues: ['first_person_owner'] },
  } as Pick<AddressCandidate, 'id' | 'address' | 'context'>,
  capture: { id: 'cap-1', sourceId: 'wykop', url: 'https://example.org/post', finalUrl: 'https://example.org/post' },
  source: { id: 'wykop', llmAllowed: true },
  runId: 'run-1',
  caseId: 'case-1',
  ...over,
});

describe('address role prompt', () => {
  it('is registered with a strict schema whose roles equal ROLE_CUES', () => {
    expect(getPrompt('address-role-classification', 'v1')).toBe(addressRolePromptV1);
    const schema = addressRolePromptV1.jsonSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: { role: { enum: string[] } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.toSorted()).toEqual(['confidence', 'evidenceSpan', 'rationale', 'role']);
    expect(schema.properties.role.enum).toContain('exchange_deposit');
    expect(addressRolePromptV1.system).toContain('UNTRUSTED_DATA');
  });
});

describe('classifyAddressMention', () => {
  it('returns a pending-style suggestion with the lexicon agreement and the model identity', async () => {
    const { client, requests } = fakeLlm({});
    const out = await classifyAddressMention(input({ linkAssessmentId: 'link-1' }), { llm: client });
    expect(out.status).toBe('suggested');
    if (out.status !== 'suggested') return;
    expect(out.suggestion).toMatchObject({
      task: 'address-role-classification',
      label: 'first_person_owner',
      model: 'fake-model',
      modelDigest: 'abc',
      promptVersion: 'v1',
      callId: 'call-1',
      target: { candidateId: 'cand-1', linkAssessmentId: 'link-1' },
      output: { agreement: 'agrees', evidenceSpan: 'mój portfel USDT TRC20' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.containsIdentifier).toBe(true);
    expect(requests[0]?.untrustedInput).toContain(`fragment: ${SNIPPET}`);
  });

  it('rejects an evidence span that is not in the scraped text', async () => {
    const { client } = fakeLlm({ evidenceSpan: 'to jest adres oszusta' });
    expect(await classifyAddressMention(input(), { llm: client })).toEqual({
      status: 'failed',
      reason: 'span_not_in_input',
      callId: 'call-1',
    });
  });

  it('does not accept a span taken from the address line', async () => {
    const { client } = fakeLlm({ evidenceSpan: 'sieć: tron' });
    const out = await classifyAddressMention(input(), { llm: client });
    expect(out).toMatchObject({ status: 'failed', reason: 'span_not_in_input' });
  });

  it('never sends Telegram text, by source id, host or archive origin', async () => {
    const { client, requests } = fakeLlm({});
    const telegram = input({
      capture: { id: 'c', sourceId: 'telegram_preview', url: 'https://t.me/s/x', finalUrl: 'https://t.me/s/x' },
      source: { id: 'telegram_preview', llmAllowed: false },
    });
    // Even a register entry that wrongly allows it is refused by id.
    const wrongRegister = input({
      capture: { id: 'c', sourceId: 'telegram_preview', url: 'https://x.org', finalUrl: 'https://x.org' },
      source: { id: 'telegram_preview', llmAllowed: true },
    });
    const wayback = input({
      capture: {
        id: 'c',
        sourceId: 'wayback_cdx',
        url: 'https://web.archive.org/web/1/https://t.me/s/x',
        finalUrl: 'https://web.archive.org/web/1/https://t.me/s/x',
        archive: { provider: 'wayback', snapshotTimestamp: '20260101000000', originalUrl: 'https://t.me/s/x' },
      },
      source: { id: 'wayback_cdx', llmAllowed: true },
    });
    for (const i of [telegram, wrongRegister, wayback]) {
      expect(await classifyAddressMention(i, { llm: client })).toEqual({
        status: 'skipped',
        reason: 'llm_not_allowed',
      });
    }
    expect(requests).toHaveLength(0);
    expect(isLlmAllowed(input().capture, undefined)).toBe(false);
    expect(isLlmAllowed(input().capture, input().source)).toBe(true);
  });

  it('skips when the model is disabled or the snippet is too short, without a call', async () => {
    const off = fakeLlm({}, false);
    expect(await classifyAddressMention(input(), { llm: off.client })).toEqual({
      status: 'skipped',
      reason: 'llm_disabled',
    });
    const on = fakeLlm({});
    const short = input({
      candidate: {
        id: 'c',
        address: { chain: 'tron', address: ADDRESS },
        context: { snippet: 'krótko', inCode: false, roleCues: [], pageAddressDensity: 1, occurrencesInCapture: 1 },
      },
    });
    expect(await classifyAddressMention(short, { llm: on.client })).toEqual({
      status: 'skipped',
      reason: 'snippet_too_short',
    });
    expect(off.requests.length + on.requests.length).toBe(0);
  });

  it('reports a model failure as a typed result, not an exception', async () => {
    const { client } = fakeLlm('fail');
    expect(await classifyAddressMention(input(), { llm: client })).toEqual({
      status: 'failed',
      reason: 'timeout',
      callId: 'call-0',
    });
  });

  it('windows a long snippet around the address instead of cutting its end', async () => {
    const long = `${'a '.repeat(900)}mój portfel: ${ADDRESS} ${'b '.repeat(900)}`;
    const { client, requests } = fakeLlm({ evidenceSpan: 'mój portfel' });
    const i = input({
      candidate: {
        id: 'c',
        address: { chain: 'tron', address: ADDRESS },
        context: { snippet: long, inCode: false, roleCues: [], pageAddressDensity: 1, occurrencesInCapture: 1 },
      },
    });
    const out = await classifyAddressMention(i, { llm: client });
    expect(out.status).toBe('suggested');
    expect(requests[0]?.untrustedInput.length).toBeLessThanOrEqual(1200);
    expect(requests[0]?.untrustedInput).toContain(ADDRESS);
  });
});

describe('lexiconAgreement', () => {
  it('agrees, differs or stays silent', () => {
    expect(lexiconAgreement('donation', ['donation', 'quote'])).toBe('agrees');
    expect(lexiconAgreement('donation', ['scam_report'])).toBe('differs');
    expect(lexiconAgreement('donation', [])).toBe('lexicon_silent');
    expect(lexiconAgreement('donation', ['unclear'])).toBe('lexicon_silent');
  });
});
