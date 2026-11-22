/** `recordDelegated` merges the request log of an internal delegate (osint-py) into the egress log; no network I/O. */
import { createHash } from 'node:crypto';
import type {
  BlobRef,
  BlobStore,
  DelegatedRequestRecord,
  EgressLogEntry,
  ProvenanceEnvelope,
  SourceDescriptor,
} from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { createEgressClient, EgressDeniedError } from '../src/index.ts';

const SOURCE: SourceDescriptor = {
  id: 'maigret',
  name: 'Maigret',
  kind: 'username_enumeration',
  compliance: 'AMBER',
  complianceNote: 'test',
  tosUrl: null,
  namePl: 'Maigret',
  complianceNotePl: 'test',
  enabledByDefault: false,
  requiresApiKey: false,
  sendsIdentifiersExternally: true,
  reliability: 'C',
  rateLimit: { requests: 4, perSeconds: 1 },
  allowedHosts: [],
};

function setup(sources: SourceDescriptor[] = [SOURCE]) {
  const logs: EgressLogEntry[] = [];
  const envelopes: ProvenanceEnvelope[] = [];
  const stored = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    async put(bytes, mediaType): Promise<BlobRef> {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      stored.set(sha256, bytes);
      return { sha256, bytes: bytes.byteLength, mediaType };
    },
    async get(sha256) {
      return stored.get(sha256) as Uint8Array;
    },
    async has(sha256) {
      return stored.has(sha256);
    },
  };
  const client = createEgressClient({
    mode: 'offline',
    runId: 'run-1',
    enabledSources: sources,
    blobs,
    sinks: { log: (e) => void logs.push(e), provenance: (p) => void envelopes.push(p) },
    toolVersion: 'test',
  });
  return { client, logs, envelopes, stored };
}

const record = (overrides: Partial<DelegatedRequestRecord> = {}): DelegatedRequestRecord => ({
  method: 'GET',
  url: 'http://fixture-site:4100/wykop/ludzie/fikcyjny_kacper?token=abc',
  purpose: 'username enumeration',
  containsIdentifier: true,
  allowed: true,
  requestedAt: '2026-11-22T08:00:00.000Z',
  receivedAt: '2026-11-22T08:00:00.100Z',
  httpStatus: 200,
  responseHeaders: { 'content-type': 'text/html', 'x-olcys-synthetic': 'true' },
  body: new TextEncoder().encode('<html>profil</html>'),
  userAgent: 'OLCYS/0.1.0 (OSINT research prototype)',
  ...overrides,
});

describe('recordDelegated', () => {
  it('writes one log row per record, marked with the delegate, and a provenance envelope for each body', async () => {
    const { client, logs, envelopes, stored } = setup();
    const out = await client.recordDelegated?.({
      delegate: 'osint-py',
      sourceId: 'maigret',
      viaFetchId: 'via-1',
      toolVersion: 'maigret 0.6.6',
      records: [
        record(),
        record({ url: 'http://fixture-site:4100/telegram/x', httpStatus: 404, body: undefined }),
        record({
          url: 'http://elsewhere.invalid/x',
          allowed: false,
          denyReason: 'host not allow-listed',
          httpStatus: undefined,
          body: undefined,
        }),
      ],
    });
    expect(out).toHaveLength(3);
    expect(logs.map((l) => [l.host, l.allowed, l.httpStatus, l.delegate, l.containsIdentifier])).toEqual([
      ['fixture-site', true, 200, 'osint-py', true],
      ['fixture-site', true, 404, 'osint-py', true],
      ['elsewhere.invalid', false, undefined, 'osint-py', true],
    ]);
    expect(logs[2]?.denyReason).toBe('host not allow-listed');
    expect(logs[0]?.urlRedacted).toContain('token=REDACTED');
    expect(logs.every((l) => l.runId === 'run-1' && l.sourceId === 'maigret' && l.mode === 'offline')).toBe(true);
    // Only the record with a body has provenance.
    expect(out?.map((o) => o.provenance !== undefined)).toEqual([true, false, false]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      delegatedVia: { delegate: 'osint-py', fetchId: 'via-1' },
      sourceId: 'maigret',
      httpStatus: 200,
      toolVersion: 'maigret 0.6.6',
      userAgent: 'OLCYS/0.1.0 (OSINT research prototype)',
      egressLogId: out?.[0]?.egressLogId,
      synthetic: true,
    });
    expect(stored.has(envelopes[0]?.body.sha256 as string)).toBe(true);
  });

  it('refuses a source that is not enabled for the run', async () => {
    const { client, logs } = setup([]);
    await expect(
      client.recordDelegated?.({
        delegate: 'osint-py',
        sourceId: 'maigret',
        viaFetchId: 'via-1',
        toolVersion: 'x',
        records: [record()],
      }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(logs).toEqual([]);
  });
});
