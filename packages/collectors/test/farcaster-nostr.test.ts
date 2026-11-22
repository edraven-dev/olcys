/**
 * Farcaster (AMBER) and Nostr NIP-05. Live-shaped behaviour runs against a fake `fetch` behind the real egress client;
 * offline behaviour reads the synthetic answers of the fixture site. Keys are generated at test time, nothing is
 * committed. The demo persona is unknown to both lookups.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base64, hex } from '@scure/base';
import type { CollectorInput, CollectorResult, FetchMode, SourceId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MORE_IDENTITY } from '../../../apps/fixture-site/scripts/lib/more-identity.ts';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  claimDigest,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createFarcasterCollector,
  createNostrCollector,
  DEFAULT_SOURCES_PATH,
  farcasterTimeToIso,
  npubDecode,
  npubEncode,
  parseNip05,
  parseSourceRegistry,
  PIVOT_RULES_VERSION,
  planInitial,
  type PlannerContext,
  runCollector,
  SourceCircuitBreaker,
  type CollectorDeps,
  type CollectorFactory,
  type SourceRegistry,
} from '../src/index.ts';
import { createTestRun, demoRegistry, identifier, startFixture, testConfig, TEST_REDACTOR } from './helpers.ts';
import { readFileSync } from 'node:fs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const JUSTIFICATION = 'Sprawa testowa 2026/1: dane syntetyczne, weryfikacja adresów';
const FID = '999999999';
const NIP05_HOST = 'nostr.example.org';

let registry: SourceRegistry;
let server: FixtureServer;
beforeAll(async () => {
  registry = await demoRegistry();
  server = await startFixture('v1');
});
afterAll(async () => {
  await server.close();
});

const props = (r: CollectorResult, property: string) => r.observations.filter((o) => o.property === property);
const values = (r: CollectorResult, property: string) => props(r, property).map((o) => o.value);
const input = (platform: string, value: string, kind: 'nickname' | 'social_login' = 'nickname'): CollectorInput => ({
  identifiers: [identifier(kind, value, { platform })],
  accounts: [],
  addresses: [],
  depth: 0,
});

type Answer = { status: number; body?: string; headers?: Record<string, string> };
function liveSetup(answer: (url: string) => Answer, sources: SourceId[], env: Record<string, string> = {}) {
  const mode: FetchMode = 'live';
  const sent: { url: string; method: string }[] = [];
  const fetchImpl = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    sent.push({ url, method: init?.method ?? 'GET' });
    const { status, body, headers } = answer(url);
    return new Response(body ?? '', { status, headers: { ...JSON_TYPE, ...headers } });
  }) as typeof fetch;
  const reg = env['OLCYS_SOURCE_HOSTS_NOSTR']
    ? parseSourceRegistry(readFileSync(DEFAULT_SOURCES_PATH, 'utf8'), env)
    : registry;
  const scope = reg.resolveScope({ enabledSources: sources, amberJustifications: { farcaster: JUSTIFICATION } }, mode);
  const test = createTestRun(scope, mode, 'run-more', { fetchImpl });
  const deps: CollectorDeps = {
    mode,
    config: createCollectorConfig({ mode, env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const run = (factory: CollectorFactory, i: CollectorInput): Promise<CollectorResult> =>
    runCollector(factory.create(reg.require(factory.sourceId), deps), i, test.ctx, scope, deps);
  return { sent, test, run };
}

// --- Farcaster ------------------------------------------------------------------------------------------------------

const hexOf = (b: Uint8Array) => `0x${hex.encode(b)}`;
/** One ETH verification message, signed with an ephemeral key at test time. */
function ethMessage(opts: { flip?: boolean; encoding?: 'hex' | 'base64'; contract?: boolean } = {}) {
  const key = secp256k1.utils.randomSecretKey();
  const address = keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(-20);
  const blockHash = secp256k1.utils.randomSecretKey();
  const signed = secp256k1.sign(claimDigest({ fid: BigInt(FID), address, blockHash, network: 1 }), key, {
    prehash: false,
    format: 'recovered',
  });
  const signature = Uint8Array.of(...signed.subarray(1), 27 + (signed[0] ?? 0));
  if (opts.flip) signature[10] = (signature[10] ?? 0) ^ 0xff;
  const enc = (b: Uint8Array) => (opts.encoding === 'base64' ? base64.encode(b) : hexOf(b));
  return {
    address: hexOf(address),
    message: {
      data: {
        fid: Number(FID),
        timestamp: 157_766_400,
        network: 'FARCASTER_NETWORK_MAINNET',
        verificationAddAddressBody: {
          address: enc(address),
          claimSignature: enc(signature),
          blockHash: enc(blockHash),
          verificationType: opts.contract ? 1 : 0,
          chainId: opts.contract ? 10 : 0,
          protocol: 'PROTOCOL_ETHEREUM',
        },
      },
      hash: '0xaa',
    },
  };
}
const solMessage = () => ({
  data: {
    fid: Number(FID),
    timestamp: 1,
    verificationAddAddressBody: {
      address: base64.encode(secp256k1.utils.randomSecretKey()),
      claimSignature: base64.encode(new Uint8Array(64)),
      blockHash: base64.encode(new Uint8Array(32)),
      protocol: 'PROTOCOL_SOLANA',
    },
  },
  hash: '0xbb',
});
const hubAnswer =
  (verifications: () => unknown[], extra: (url: string) => Answer | undefined = () => undefined) =>
  (url: string): Answer => {
    const custom = extra(url);
    if (custom) return custom;
    if (url.includes('/v1/userNameProofByName')) {
      return {
        status: 200,
        body: JSON.stringify({ fid: Number(FID), name: 'fikcyjny-kacper', type: 'USERNAME_TYPE_FNAME' }),
      };
    }
    if (url.includes('/v1/userDataByFid')) {
      return {
        status: 200,
        body: JSON.stringify({
          messages: [
            { data: { userDataBody: { type: 'USER_DATA_TYPE_BIO', value: 'moj token: TESTSECRET-abc123 SYNTHETIC' } } },
            { data: { userDataBody: { type: 'USER_DATA_TYPE_GITHUB', value: 'olcys-test-marek' } } },
          ],
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ messages: verifications(), nextPageToken: '' }) };
  };

describe('Farcaster collector', () => {
  it('checks claims locally: valid, flipped signature, contract wallet and Solana', async () => {
    const good = ethMessage();
    const flipped = ethMessage({ flip: true });
    const contract = ethMessage({ contract: true });
    const { run, sent, test } = liveSetup(
      hubAnswer(() => [good.message, flipped.message, contract.message, solMessage()]),
      ['farcaster'],
    );
    const result = await run(createFarcasterCollector(), input('farcaster', 'fikcyjny-kacper'));
    expect(result.status).toBe('ok');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ platform: 'farcaster', platformUserId: FID, handle: 'fikcyjny-kacper' });
    expect(values(result, 'computed.claim_signature_check').toSorted()).toEqual([
      'invalid',
      'unverifiable_contract',
      'unverifiable_solana',
      'valid',
    ]);
    // Locators carry the canonical address so a removed verification is a removal of that locator only.
    expect(props(result, 'verification.eth_address').map((o) => o.locator)).toContain(
      `farcaster:fid=${FID}#verification.eth_address[${good.address}]`,
    );
    expect(values(result, 'verification.added_at')).toContain('2026-01-01T00:00:00.000Z');
    // Only the node's host, always marked as carrying an identifier.
    expect(new Set(sent.map((s) => new URL(s.url).host))).toEqual(new Set(['haatz.quilibrium.com']));
    expect(test.logs.every((l) => l.sourceId === 'farcaster' && l.containsIdentifier)).toBe(true);
    // The GitHub account of the profile is followed through account.link; the bio is redacted before storage.
    expect(values(result, 'account.link')).toEqual(['https://github.com/olcys-test-marek']);
    expect(values(result, 'profile.bio').join()).not.toContain('TESTSECRET');
  });

  it('reads hex and base64 bodies alike', async () => {
    const a = ethMessage({ encoding: 'hex' });
    const b = { ...ethMessage({ encoding: 'base64' }) };
    const one = await liveSetup(
      hubAnswer(() => [a.message]),
      ['farcaster'],
    ).run(createFarcasterCollector(), input('farcaster', 'x-name'));
    const two = await liveSetup(
      hubAnswer(() => [b.message]),
      ['farcaster'],
    ).run(createFarcasterCollector(), input('farcaster', 'x-name'));
    expect(values(one, 'computed.claim_signature_check')).toEqual(['valid']);
    expect(values(two, 'computed.claim_signature_check')).toEqual(['valid']);
    expect(values(two, 'verification.eth_address')[0]).toBe(b.address);
  });

  it('follows exactly one next page, and a page cap makes the result partial with a truncated note', async () => {
    const page1 = ethMessage();
    const page2 = ethMessage();
    const answer = hubAnswer(
      () => [],
      (url) => {
        if (!url.includes('/v1/verificationsByFid')) return undefined;
        return url.includes('pageToken=tok1')
          ? { status: 200, body: JSON.stringify({ messages: [page2.message], nextPageToken: '' }) }
          : { status: 200, body: JSON.stringify({ messages: [page1.message], nextPageToken: 'tok1' }) };
      },
    );
    const full = liveSetup(answer, ['farcaster']);
    const result = await full.run(createFarcasterCollector(), input('farcaster', FID));
    expect(full.sent.filter((s) => s.url.includes('verificationsByFid'))).toHaveLength(2);
    expect(values(result, 'verification.eth_address')).toHaveLength(2);
    expect(result.status).toBe('ok');
    const capped = liveSetup(answer, ['farcaster']);
    const partial = await capped.run(createFarcasterCollector({ maxVerificationPages: 1 }), input('farcaster', FID));
    expect(capped.sent.filter((s) => s.url.includes('verificationsByFid'))).toHaveLength(1);
    expect(partial.status).toBe('partial');
    expect(partial.notes.join('\n')).toContain('truncated');
  });

  it('answers not_found for an unknown fname (404) with no account', async () => {
    const { run } = liveSetup(() => ({ status: 404, body: '{"errCode":"not_found"}' }), ['farcaster']);
    const result = await run(createFarcasterCollector(), input('farcaster', 'nikt-taki'));
    expect(result.status).toBe('not_found');
    expect(result.accounts).toHaveLength(0);
    expect(result.captures.map((c) => c.status)).toEqual(['not_found']);
  });

  it('time conversion and input rules', async () => {
    expect(farcasterTimeToIso(0)).toBe('2021-01-01T00:00:00.000Z');
    expect(farcasterTimeToIso(157_766_400)).toBe('2026-01-01T00:00:00.000Z');
    const { run, sent } = liveSetup(() => ({ status: 200, body: '{}' }), ['farcaster']);
    const noPlatform = await run(createFarcasterCollector(), input('github', 'fikcyjny-kacper'));
    expect(noPlatform.status).not.toBe('ok');
    expect(sent).toHaveLength(0);
  });

  it('reads the synthetic node offline: the test identity is found and verifies', async () => {
    const scope = registry.resolveScope(
      { enabledSources: ['farcaster'], amberJustifications: { farcaster: JUSTIFICATION } },
      'offline',
    );
    const test = createTestRun(scope);
    const deps: CollectorDeps = {
      mode: 'offline',
      config: await testConfig(server),
      robots: test.robots,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collect = (value: string) =>
      runCollector(
        createFarcasterCollector().create(registry.require('farcaster'), deps),
        input('farcaster', value),
        test.ctx,
        scope,
        deps,
      );
    const found = await collect(MORE_IDENTITY.fname);
    expect(found.status).toBe('ok');
    expect(found.accounts[0]).toMatchObject({ platformUserId: String(MORE_IDENTITY.fid) });
    expect(values(found, 'computed.claim_signature_check').toSorted()).toEqual(['unverifiable_solana', 'valid']);
    // The demo persona's nick is unknown there.
    expect((await collect('fikcyjny-kacper')).status).toBe('not_found');
  });
});

// --- Nostr ----------------------------------------------------------------------------------------------------------

const PUBKEY = hex.encode(secp256k1.utils.randomSecretKey());
const NOSTR_ENV = { OLCYS_SOURCE_HOSTS_NOSTR: NIP05_HOST };
const nip05Body = JSON.stringify({
  names: { olcys_test_nostr: PUBKEY },
  relays: { [PUBKEY]: ['wss://relay.example.org', 'https://not-a-relay.example'] },
});

describe('Nostr NIP-05 collector', () => {
  it('identifies the key; relay hints are facts and never contacted', async () => {
    const { run, sent, test } = liveSetup(() => ({ status: 200, body: nip05Body }), ['nostr'], NOSTR_ENV);
    const result = await run(createNostrCollector(), input('nostr', `olcys_test_nostr@${NIP05_HOST}`));
    expect(result.status).toBe('ok');
    expect(sent).toEqual([
      { url: `https://${NIP05_HOST}/.well-known/nostr.json?name=olcys_test_nostr`, method: 'GET' },
    ]);
    expect(test.logs.every((l) => l.containsIdentifier && l.sourceId === 'nostr')).toBe(true);
    expect(result.accounts[0]).toMatchObject({ platform: 'nostr', platformUserId: PUBKEY });
    expect(values(result, 'nostr.npub')).toEqual([npubEncode(PUBKEY)]);
    expect(values(result, 'nostr.relay_hint')).toEqual(['wss://relay.example.org']);
  });

  it('a redirect is ignored: not_found after exactly one request', async () => {
    const { run, sent } = liveSetup(
      () => ({ status: 301, headers: { location: 'https://elsewhere.example/' } }),
      ['nostr'],
      NOSTR_ENV,
    );
    const result = await run(createNostrCollector(), input('nostr', `olcys_test_nostr@${NIP05_HOST}`));
    expect(result.status).toBe('not_found');
    expect(result.accounts).toHaveLength(0);
    expect(result.notes.join('\n')).toContain('redirect ignored');
    expect(sent).toHaveLength(1);
  });

  it('a name missing from the answer is not found; a plain e-mail or a domain outside the allow-list sends nothing', async () => {
    const missing = liveSetup(() => ({ status: 200, body: '{"names":{}}' }), ['nostr'], NOSTR_ENV);
    expect((await missing.run(createNostrCollector(), input('nostr', `olcys_test_nostr@${NIP05_HOST}`))).status).toBe(
      'not_found',
    );
    const mail = liveSetup(() => ({ status: 200, body: nip05Body }), ['nostr'], NOSTR_ENV);
    const email: CollectorInput = {
      identifiers: [identifier('email', `olcys_test_nostr@${NIP05_HOST}`)],
      accounts: [],
      addresses: [],
      depth: 0,
    };
    expect((await mail.run(createNostrCollector(), email)).status).not.toBe('ok');
    expect(mail.sent).toHaveLength(0);
    const denied = liveSetup(() => ({ status: 200, body: nip05Body }), ['nostr'], NOSTR_ENV);
    const result = await denied.run(createNostrCollector(), input('nostr', 'olcys_test_nostr@other.example'));
    expect(denied.sent).toHaveLength(0);
    expect(result.notes.join('\n')).toContain('allow_list_denied');
  });

  it('npub codec and NIP-05 parsing', () => {
    for (let i = 0; i < 3; i += 1) {
      const key = hex.encode(secp256k1.utils.randomSecretKey());
      expect(npubDecode(npubEncode(key))).toBe(key);
    }
    const npub = npubEncode(PUBKEY);
    expect(() => npubDecode(`${npub.slice(0, -1)}${npub.endsWith('q') ? 'p' : 'q'}`)).toThrow(
      /checksum|bech32|Invalid/i,
    );
    expect(parseNip05('_@Example.org')).toEqual({ name: '_', domain: 'example.org' });
    expect(parseNip05('no-at-sign')).toBeUndefined();
  });

  it('reads the synthetic NIP-05 domain offline', async () => {
    const scope = registry.resolveScope({ enabledSources: ['nostr'], amberJustifications: {} }, 'offline');
    const test = createTestRun(scope);
    const deps: CollectorDeps = {
      mode: 'offline',
      config: await testConfig(server),
      robots: test.robots,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collect = (id: string) =>
      runCollector(
        createNostrCollector().create(registry.require('nostr'), deps),
        input('nostr', id),
        test.ctx,
        scope,
        deps,
      );
    const found = await collect(MORE_IDENTITY.nip05);
    expect(found.status).toBe('ok');
    expect(values(found, 'nostr.nip05')).toEqual([MORE_IDENTITY.nip05]);
    expect((await collect('olcys_test_other@nostr.example.org')).status).toBe('not_found');
  });
});

describe('planner pivot.v4 for Farcaster and Nostr', () => {
  it('plans them from an identifier given for the platform only, never from a nick', async () => {
    const scope = registry.resolveScope(
      { enabledSources: ['farcaster', 'nostr'], amberJustifications: { farcaster: JUSTIFICATION } },
      'offline',
    );
    const config = await testConfig(server);
    const collectors = createDefaultCollectorRegistry({ mode: 'offline' });
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const ctx: PlannerContext = {
      scope,
      factories: collectors.list(),
      collectors: collectors.forScope(scope, registry, deps),
      known: new Set(),
      maxPivotDepth: 2,
      maxTasks: 40,
      counter: { planned: 0 },
      watchList: [],
      fixture: config.fixture,
    };
    expect(PIVOT_RULES_VERSION).toBe('pivot.v4');
    const nick = planInitial([identifier('nickname', 'fikcyjny-kacper')], ctx);
    expect(nick.tasks.some((t) => t.sourceId === 'farcaster' || t.sourceId === 'nostr')).toBe(false);
    const given = planInitial([identifier('nickname', 'olcys-test-marek', { platform: 'farcaster' })], ctx);
    expect(given.tasks.filter((t) => t.sourceId === 'farcaster' && t.provenance.rule === 'I1')).toHaveLength(1);
  });
});
