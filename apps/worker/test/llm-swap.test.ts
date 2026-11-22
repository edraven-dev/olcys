import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.ts';
import { llmSnapshot } from '../src/llm.ts';
import { runLlmCheck } from '../src/llm-check.ts';
import { llmConfigFromEnv } from '@olcys/llm';

interface Fake {
  server: Server;
  baseUrl: string;
  requests: { method: string; url: string; model?: string }[];
}

/** A fake OpenAI-compatible server on loopback serving one model id. */
async function startFake(model: string, prefix: string): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry: Fake['requests'][number] = { method: req.method ?? '', url: req.url ?? '' };
    if (text) entry.model = (JSON.parse(text) as { model: string }).model;
    requests.push(entry);
    res.setHeader('content-type', 'application/json');
    if (req.url === `${prefix}/models`) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
    } else if (req.url === `${prefix}/chat/completions`) {
      res.end(
        JSON.stringify({
          model,
          choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`, requests };
}

let first: Fake;
let second: Fake;
beforeAll(async () => {
  first = await startFake('model-a', '/v3');
  second = await startFake('model-b', '/v1');
});
afterAll(async () => {
  await Promise.all([first, second].map((fake) => new Promise<void>((resolve) => fake.server.close(() => resolve()))));
});

const stop = (fake: Fake) => fake.requests.length;

describe('model swap by environment only', () => {
  it('moves the check and the calls to the second server when only LLM_BASE_URL and LLM_MODEL change', async () => {
    const base = { LLM_ENABLED: 'false', LLM_MODEL_DIGEST: 'sha256:abc' };
    const a = await runLlmCheck({ ...base, LLM_BASE_URL: first.baseUrl, LLM_MODEL: 'model-a' });
    expect(a).toMatchObject({
      ok: true,
      model: 'model-a',
      served: ['model-a'],
      modelListed: true,
      modelDigest: 'sha256:abc',
    });
    expect(a.probe).toEqual({ ok: true, output: { ok: true } });
    expect(stop(first)).toBe(2);
    expect(stop(second)).toBe(0);

    const b = await runLlmCheck({ ...base, LLM_BASE_URL: second.baseUrl, LLM_MODEL: 'model-b' });
    expect(b).toMatchObject({ ok: true, model: 'model-b', served: ['model-b'] });
    expect(stop(first)).toBe(2);
    expect(second.requests).toEqual([
      { method: 'GET', url: '/v1/models' },
      { method: 'POST', url: '/v1/chat/completions', model: 'model-b' },
    ]);
    expect(a.endpoint).not.toBe(b.endpoint);
  });

  it('fails when the model is not served or the server is unreachable', async () => {
    const missing = await runLlmCheck({ LLM_BASE_URL: first.baseUrl, LLM_MODEL: 'other' });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join(' ')).toContain('is not served');
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const down = await runLlmCheck({ LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_MODEL: 'm' });
    expect(down.ok).toBe(false);
    expect(down.probe.ok).toBe(false);
  });
});

describe('model identity in the run config snapshot', () => {
  it('records host, model, digest and the enabled flag, without credentials or query', () => {
    const config = llmConfigFromEnv({
      LLM_ENABLED: 'true',
      LLM_BASE_URL: 'http://user:secret@127.0.0.1:2140/v3?key=1',
      LLM_MODEL: 'qwen-test',
      LLM_MODEL_DIGEST: 'sha256:abc',
    });
    expect(llmSnapshot(config)).toEqual({
      baseUrl: 'http://127.0.0.1:2140/v3',
      model: 'qwen-test',
      modelDigest: 'sha256:abc',
      enabled: true,
    });
    expect(llmSnapshot(llmConfigFromEnv({ LLM_BASE_URL: 'http://localhost:2140/v3', LLM_MODEL: 'm' }))).toEqual({
      baseUrl: 'http://localhost:2140/v3',
      model: 'm',
      modelDigest: 'none',
      enabled: false,
    });
  });

  it('puts it into the snapshot of every run the runtime creates', async () => {
    const runtime = await createRuntime({
      env: { OLCYS_BLOBS: 'memory', LLM_ENABLED: 'true', LLM_BASE_URL: first.baseUrl, LLM_MODEL: 'model-a' },
    });
    try {
      expect(runtime.config.snapshot.llm).toEqual({
        baseUrl: first.baseUrl,
        model: 'model-a',
        modelDigest: 'none',
        enabled: true,
      });
    } finally {
      await runtime.close();
    }
  });
});
