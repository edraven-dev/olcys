import { afterEach, describe, expect, it } from 'vitest';
import { api, ApiRequestError, errorMessage, itemsOf, parseErrorBody, setFetch } from '../src/lib/api.ts';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => setFetch((input, init) => fetch(input, init)));

describe('API client parsing', () => {
  it('parses every error body shape into a stable code', () => {
    expect(
      parseErrorBody(400, { error: 'invalid_input', message: 'x', issues: [{ path: 'title', message: 'm' }] }),
    ).toEqual({ code: 'invalid_input', message: 'x', issues: [{ path: 'title', message: 'm' }] });
    expect(parseErrorBody(409, { error: { code: 'run_active', message: 'busy' } })).toMatchObject({
      code: 'run_active',
    });
    expect(parseErrorBody(404, { statusCode: 404, error: 'Not Found', message: 'Route not found' })).toMatchObject({
      code: 'not_found',
    });
    expect(parseErrorBody(502, undefined)).toMatchObject({ code: 'internal' });
  });

  it('unwraps list responses', () => {
    expect(itemsOf<number>({ items: [1, 2] })).toEqual([1, 2]);
    expect(itemsOf<number>([3])).toEqual([3]);
    expect(itemsOf<number>({ nothing: true })).toEqual([]);
  });

  it('maps errors to Polish messages and never shows the server text', () => {
    expect(errorMessage(new ApiRequestError(0, 'network', 'fetch failed'))).toBe(
      'Brak połączenia z serwerem OŁCyŚ. Spróbuj ponownie.',
    );
    expect(errorMessage(new ApiRequestError(400, 'source_forbidden', 'RED'))).toBe(
      'To źródło jest zablokowane (status RED) i nie może zostać włączone.',
    );
    expect(errorMessage(new ApiRequestError(418, 'teapot', 'I am a teapot'))).toBe(
      'Wystąpił nieoczekiwany błąd (teapot).',
    );
    expect(errorMessage(new Error('boom'))).toBe('Wystąpił nieoczekiwany błąd (client).');
  });
});

describe('API client requests', () => {
  it('sends JSON and unwraps lists', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    setFetch(async (url, init) => {
      calls.push({ url, init });
      return url === '/api/cases' && init?.method === 'POST'
        ? json(201, { id: 'c-1' })
        : json(200, { items: [{ id: 'c-1' }] });
    });
    expect(await api.post('/api/cases', { title: 'x' })).toEqual({ id: 'c-1' });
    expect(calls[0]?.init?.body).toBe('{"title":"x"}');
    expect(await api.list('/api/cases')).toEqual([{ id: 'c-1' }]);
  });

  it('throws typed errors, treats a missing optional route as null and reports network failures', async () => {
    setFetch(async () => json(400, { error: 'invalid_input', message: 'bad', issues: [] }));
    await expect(api.get('/api/cases/x')).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    setFetch(async () => json(404, { statusCode: 404, error: 'Not Found', message: 'Route not found' }));
    expect(await api.listOptional('/api/labels')).toBeNull();
    expect(await api.exists('/api/runs/r/report')).toBe(false);
    setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.get('/api/cases')).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses to call anything but its own API', async () => {
    await expect(api.get('https://example.org/api/x')).rejects.toThrow(/only talks to its own API/);
  });
});
