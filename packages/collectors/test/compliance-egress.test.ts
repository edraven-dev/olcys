/** The register drives the real egress client: a source the case does not enable cannot be contacted. */
import { createEgressClient, EgressDeniedError } from '@olcys/http';
import type { EgressLogEntry } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { loadSourceRegistry, redBlockedHosts } from '../src/index.ts';
import { MemoryBlobs } from './helpers.ts';

async function setup(scope: { enabledSources: string[]; amberJustifications: Record<string, string> }) {
  const registry = await loadSourceRegistry();
  const resolved = registry.resolveScope(scope, 'live');
  const calls: string[] = [];
  const logs: EgressLogEntry[] = [];
  const client = createEgressClient({
    mode: 'live',
    runId: 'run-1',
    enabledSources: resolved.egressSources,
    redHosts: redBlockedHosts(registry.list()),
    blobs: new MemoryBlobs(),
    sinks: { log: (e) => void logs.push(e), provenance: () => {} },
    toolVersion: 'test',
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
  });
  return { client, calls, logs };
}

const request = (url: string, sourceId: string) => ({ url, sourceId, purpose: 'test', containsIdentifier: true });

describe('register and egress client', () => {
  it('denies bitcointalk.org when the scope does not enable it, before any fetch', async () => {
    const { client, calls, logs } = await setup({ enabledSources: ['keybase'], amberJustifications: {} });
    await expect(
      client.fetch(request('https://bitcointalk.org/index.php?topic=1', 'bitcointalk')),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ allowed: false, host: 'bitcointalk.org', containsIdentifier: true });
  });

  it('allows it once the case enables it with a justification', async () => {
    const { client, calls } = await setup({
      enabledSources: ['bitcointalk'],
      amberJustifications: { bitcointalk: 'Sprawa testowa: strony forum widoczne dla gości' },
    });
    await client.fetch(request('https://bitcointalk.org/index.php?topic=1', 'bitcointalk'));
    expect(calls).toEqual(['https://bitcointalk.org/index.php?topic=1']);
  });

  it('denies a RED host even for an enabled source with the host as a redirect target', async () => {
    const { client, calls } = await setup({ enabledSources: ['keybase'], amberJustifications: {} });
    await expect(client.fetch(request('https://api.x.com/2/users', 'keybase'))).rejects.toThrow(/RED/);
    expect(calls).toEqual([]);
  });
});
