/**
 * The request guard: loopback hosts only (421 otherwise), no cross-site writes (403), tools without an Origin pass.
 * Fastify's inject, in-memory store, no network.
 */
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { listFromEnv } from '../src/guard.ts';

const app = (guard?: Parameters<typeof buildApp>[0]['guard']) =>
  buildApp({
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    sources: [],
    startRun: async () => ({}) as never,
    guard,
  });
const get = (a: ReturnType<typeof app>, host?: string) =>
  a.inject({ method: 'GET', url: '/api/health', headers: host ? { host } : {} });

const post = (a: ReturnType<typeof app>, origin?: string, method: 'POST' | 'PUT' | 'DELETE' = 'POST') =>
  a.inject({ method, url: '/api/cases', payload: { title: '' }, headers: origin ? { origin } : {} });

describe('Host header', () => {
  it('allows loopback names on any port', async () => {
    const a = app();
    const hosts = ['localhost', 'localhost:4000', '127.0.0.1:5173', '[::1]:4000', 'LOCALHOST:80'];
    const codes = await Promise.all(hosts.map(async (host) => (await get(a, host)).statusCode));
    expect(codes).toEqual(hosts.map(() => 200));
  });

  it('rejects other hosts with 421 and a JSON error (DNS rebinding)', async () => {
    const a = app();
    const hosts = ['evil.example', 'evil.example:4000', 'localhost.evil.example', '127.0.0.1.evil.example:4000'];
    const responses = await Promise.all(hosts.map((host) => get(a, host)));
    expect(responses.map((r) => r.statusCode)).toEqual(hosts.map(() => 421));
    expect(responses.map((r) => r.json())).toEqual(
      hosts.map(() => expect.objectContaining({ error: 'misdirected_request' })),
    );
  });

  it('allows extra hosts from the configuration, by name or name:port', async () => {
    const a = app({ allowedHosts: ['console.example', 'api.test:8443'] });
    expect((await get(a, 'console.example:4000')).statusCode).toBe(200);
    expect((await get(a, 'api.test:8443')).statusCode).toBe(200);
    expect((await get(a, 'api.test:80')).statusCode).toBe(421);
    expect((await get(a, 'other.example')).statusCode).toBe(421);
  });
});

describe('Origin header of state-changing requests', () => {
  it('rejects a foreign origin with 403', async () => {
    const a = app();
    const responses = await Promise.all(
      (['POST', 'PUT', 'DELETE'] as const).map((method) => post(a, 'https://evil.example', method)),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect(responses.map((r) => r.json())).toEqual(
      responses.map(() => expect.objectContaining({ error: 'forbidden_origin' })),
    );
    expect((await post(a, 'null')).statusCode).toBe(403);
    expect((await post(a, 'http://localhost:6666')).statusCode).toBe(403);
  });

  it('lets the web app and tools without an Origin through (the handler answers)', async () => {
    const a = app();
    // 400: the empty case is invalid, which means the guard let the request reach the handler.
    expect((await post(a, 'http://localhost:5173')).statusCode).toBe(400);
    expect((await post(a, 'http://127.0.0.1:5173')).statusCode).toBe(400);
    expect((await post(a)).statusCode).toBe(400);
  });

  it('does not check the Origin of reads', async () => {
    const a = app();
    const response = await a.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(response.statusCode).toBe(200);
  });

  it('follows a different web port', async () => {
    const a = app({ webPort: '5200' });
    expect((await post(a, 'http://localhost:5200')).statusCode).toBe(400);
    expect((await post(a, 'http://localhost:5173')).statusCode).toBe(403);
  });

  it('allows the origin of an extra host', async () => {
    const a = app({ allowedHosts: ['console.example'] });
    expect((await post(a, 'https://console.example')).statusCode).toBe(400);
  });
});

describe('listFromEnv', () => {
  it('splits, trims and drops empty entries', () => {
    expect(listFromEnv(' a.example, b.example:1 ,,')).toEqual(['a.example', 'b.example:1']);
    expect(listFromEnv(undefined)).toEqual([]);
    expect(listFromEnv('')).toEqual([]);
  });
});
