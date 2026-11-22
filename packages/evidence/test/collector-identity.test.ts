import { describe, expect, it } from 'vitest';
import { resolveCollectorIdentity } from '../src/index.ts';

const os = (interfaces: Record<string, { address: string; family: string; internal: boolean }[]>) => ({
  hostname: () => 'stanowisko-1',
  networkInterfaces: () => interfaces,
});

describe('collector identity', () => {
  it('uses the configured egress IP', () => {
    expect(resolveCollectorIdentity({ OLCYS_COLLECTOR_NAME: 'jan', OLCYS_COLLECTOR_IP: '192.0.2.10' }, os({}))).toEqual(
      { name: 'jan', host: 'stanowisko-1', ip: '192.0.2.10', ipSource: 'configured' },
    );
  });

  it('falls back to the first non-internal IPv4 interface by name', () => {
    const identity = resolveCollectorIdentity(
      {},
      os({
        wlan0: [{ address: '10.0.0.9', family: 'IPv4', internal: false }],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [
          { address: 'fe80::1', family: 'IPv6', internal: false },
          { address: '10.0.0.5', family: 'IPv4', internal: false },
        ],
      }),
    );
    expect(identity).toMatchObject({ name: 'olcys-worker', ip: '10.0.0.5', ipSource: 'local_interface' });
  });

  it('reports an unknown address and rejects a malformed configured one', () => {
    expect(resolveCollectorIdentity({}, os({}))).toEqual({
      name: 'olcys-worker',
      host: 'stanowisko-1',
      ipSource: 'unknown',
    });
    expect(() => resolveCollectorIdentity({ OLCYS_COLLECTOR_IP: 'nie-ip' }, os({}))).toThrow(/OLCYS_COLLECTOR_IP/);
  });
});
