import { beforeAll, describe, expect, it } from 'vitest';
import {
  allowListFor,
  createSourceRegister,
  loadSourceRegister,
  redBlockedHosts,
  type SourceRegister,
} from '../src/index.ts';
import type { SourceDescriptor } from '@olcys/core';

let register: SourceRegister;
beforeAll(async () => {
  register = await loadSourceRegister();
});

const JUSTIFICATION = 'Sprawa testowa: strony forum widoczne dla gości';
const enabled = (...ids: string[]) => ({ enabledSources: ids, amberJustifications: {} });

const base = (patch: Partial<SourceDescriptor>): SourceDescriptor => ({
  id: 'a',
  name: 'a',
  namePl: 'a',
  kind: 'web',
  compliance: 'GREEN',
  complianceNote: 'n',
  complianceNotePl: 'n',
  tosUrl: null,
  enabledByDefault: true,
  requiresApiKey: false,
  sendsIdentifiersExternally: false,
  reliability: 'B',
  rateLimit: { requests: 1, perSeconds: 1 },
  allowedHosts: ['ok.example.org', 'api.red.example.org'],
  ...patch,
});

describe('allowListFor', () => {
  it('offline: the fixture site hosts only', () => {
    expect(allowListFor(register, enabled('keybase', 'mempool_space'), 'offline')).toEqual([
      '127.0.0.1',
      'fixture-site',
      'localhost',
    ]);
  });

  it('live and replay: the union of the enabled sources hosts', () => {
    for (const mode of ['live', 'replay'] as const) {
      expect(allowListFor(register, enabled('fixture_site', 'keybase', 'mempool_space'), mode)).toEqual([
        '127.0.0.1',
        'fixture-site',
        'keybase.io',
        'localhost',
        'mempool.space',
      ]);
    }
  });

  it('adds an AMBER source only with a justification', () => {
    expect(allowListFor(register, enabled('bitcointalk'), 'live')).toEqual([]);
    expect(
      allowListFor(
        register,
        { enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: JUSTIFICATION } },
        'live',
      ),
    ).toEqual(['bitcointalk.org']);
  });

  it('never lists RED sources, unknown ids or sources that are not enabled', () => {
    expect(allowListFor(register, enabled('x_twitter', 'nope'), 'live')).toEqual([]);
  });

  it('RED wins: extra hosts and subdomains of RED hosts are removed', () => {
    expect(
      allowListFor(register, enabled('keybase'), 'live', [
        'api.x.com',
        'RPC.example.org.',
        'cdn.reddit.com',
        '*.discord.com',
        'notx.com',
      ]),
    ).toEqual(['keybase.io', 'notx.com', 'rpc.example.org']);
  });

  it('normalises: lower case, punycode, no trailing dot, sorted, unique', () => {
    expect(
      allowListFor(register, enabled('keybase'), 'live', ['Zażółć.example.org', 'b.example.org.', 'B.example.org']),
    ).toEqual(['b.example.org', 'keybase.io', 'xn--za-6ja4f8n1l.example.org'].toSorted());
  });

  it('lets a RED host blocked by a register entry win over another source allowing it', () => {
    const custom = createSourceRegister([
      base({}),
      base({
        id: 'r',
        compliance: 'RED',
        enabledByDefault: false,
        allowedHosts: [],
        rateLimit: { requests: 0, perSeconds: 1 },
        blockedHosts: ['red.example.org'],
      }),
    ]);
    expect(allowListFor(custom, enabled('a'), 'live')).toEqual(['ok.example.org']);
    expect(redBlockedHosts(custom.entries.values())).toEqual(['red.example.org']);
    const wildcard = createSourceRegister([
      base({}),
      base({
        id: 'w',
        compliance: 'RED',
        enabledByDefault: false,
        allowedHosts: [],
        rateLimit: { requests: 0, perSeconds: 1 },
        blockedHosts: ['*.red.example.org'],
      }),
    ]);
    expect(allowListFor(wildcard, enabled('a'), 'live')).toEqual(['ok.example.org']);
  });
});
