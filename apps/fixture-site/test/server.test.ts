import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PersonaManifest } from '../src/manifest.ts';
import { createFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { resolveRequest, type FixtureRoute } from '../src/resolve.ts';

const ROOT = resolve(import.meta.dirname, '..', 'public');
const MANIFEST = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'persona', 'manifest.json');

let server: FixtureServer;
let manifest: PersonaManifest;
const addr = (slot: string): string => manifest.addresses[slot]?.address ?? '';
const get = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, { redirect: 'manual', ...init });

beforeAll(async () => {
  manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as PersonaManifest;
  server = await createFixtureServer({
    root: ROOT,
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: true,
  });
});
afterAll(async () => {
  await server.close();
});

describe('fixture server', () => {
  it('serves the profile per variant and switches variants at runtime', async () => {
    const v1 = await get('/bitcointalk/index.php?action=profile;u=900001');
    expect(v1.status).toBe(200);
    expect(v1.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await v1.text();
    expect(html).toContain(addr('BTC-1'));
    expect(html).not.toContain(addr('BTC-2'));
    expect(await (await get('/bitcointalk/index.php?action=profile;user=fikcyjny_kacper')).text()).toBe(html);

    expect((await get('/__fixture/variant', { method: 'POST', body: 'v3' })).status).toBe(400);
    expect((await get('/__fixture/variant', { method: 'POST', body: 'v2' })).status).toBe(204);
    expect(await (await get('/healthz')).text()).toBe('ok v2');
    expect(await (await get('/bitcointalk/index.php?action=profile;u=900001')).text()).toContain(addr('BTC-2'));
    expect((await get('/__fixture/variant', { method: 'POST', body: 'v1' })).status).toBe(204);
  });

  it('answers unknown members like SMF and unknown paths with 404', async () => {
    const res = await get('/bitcointalk/index.php?action=profile;u=123');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('does not exist');
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/%2e%2e/%2e%2e/package.json')).status).toBe(404);
  });

  it('serves barrier pages with their status codes and headers', async () => {
    expect((await get('/barriers/forbidden')).status).toBe(403);
    const limited = await get('/barriers/rate-limited');
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '1']);
    const challenge = await get('/barriers/challenge');
    expect([challenge.status, challenge.headers.get('cf-mitigated')]).toEqual([403, 'challenge']);
    expect(await (await get('/barriers/login')).text()).toContain('data-olcys-barrier="login_wall"');
    const redirect = await get('/barriers/redirect-private');
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/private/']);
  });

  it('marks every response as synthetic and supports HEAD', async () => {
    for (const path of ['/', '/robots.txt', '/nope', '/barriers/forbidden', '/healthz']) {
      // oxlint-disable-next-line no-await-in-loop
      expect((await get(path)).headers.get('x-olcys-synthetic')).toBe('true');
    }
    const head = await get('/wykop/ludzie/fikcyjny_kacper/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
  });

  it('serves synthetic chain data in provider formats', async () => {
    const stats = (await (await get(`/chain/esplora/api/address/${addr('BTC-1')}`)).json()) as {
      chain_stats: { tx_count: number };
    };
    expect(stats.chain_stats.tx_count).toBe(5);
    const txs = (await (await get(`/chain/esplora/api/address/${addr('BTC-1')}/txs`)).json()) as unknown[];
    expect(txs).toHaveLength(5);
    expect(Number(await (await get('/chain/esplora/api/blocks/tip/height')).text())).toBeGreaterThan(970_000);

    const eth1 = addr('ETH-1').toLowerCase();
    const list = (await (
      await get(`/chain/etherscan/v2/api?chainid=1&module=account&action=txlist&address=${eth1}&sort=asc&apikey=x`)
    ).json()) as { result: { hash: string; to: string }[] };
    expect(list.result.map((r) => r.to)).toEqual([eth1, addr('HOT-1').toLowerCase()]);
    expect(list.result[0]?.hash).toBe(addr('TX-DECOY').toLowerCase());

    const code = async (address: string) =>
      (
        (await (
          await get(`/chain/etherscan/v2/api?chainid=1&module=proxy&action=eth_getCode&address=${address}`)
        ).json()) as {
          result: string;
        }
      ).result;
    expect(await code(addr('CONTRACT-1').toLowerCase())).toMatch(/^0x6080/);
    expect(await code(eth1)).toBe('0x');

    const trc20 = (await (
      await get(`/chain/trongrid/v1/accounts/${addr('TRON-1')}/transactions/trc20?limit=50`)
    ).json()) as {
      data: { value: string }[];
    };
    expect(trc20.data).toHaveLength(9);
  });
});

describe('route resolution', () => {
  it('matches query before params before queryPrefix before path-only routes', async () => {
    const routes: FixtureRoute[] = [
      { path: '/p', queryPrefix: 'a=', file: 'robots.txt', status: 203 },
      { path: '/p', params: { a: '1' }, file: 'robots.txt', status: 202 },
      { path: '/p', query: 'a=1;b', file: 'robots.txt', status: 201 },
      { path: '/p', file: 'robots.txt', status: 204 },
    ];
    const status = async (search: string) => (await resolveRequest(ROOT, 'v1', routes, '/p', search))?.status;
    expect(await status('a=1;b')).toBe(201);
    expect(await status('a=1&c=2')).toBe(202);
    expect(await status('a=9')).toBe(203);
    expect(await status('')).toBe(204);
  });

  it('refuses path traversal', async () => {
    expect(await resolveRequest(ROOT, 'v1', [], '/../../package.json', '')).toBeUndefined();
    expect(await resolveRequest(ROOT, 'v1', [{ path: '/x', file: '../../package.json' }], '/x', '')).toBeUndefined();
    expect(await resolveRequest(join(ROOT), 'v1', [], '/robots.txt', '')).toMatchObject({ status: 200 });
  });
});
