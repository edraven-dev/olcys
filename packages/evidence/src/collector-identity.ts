import { isIP } from 'node:net';
import type { CaptureManifest } from '@olcys/core';

export interface CollectorIdentity {
  name: string;
  host: string;
  ip?: string;
  ipSource: CaptureManifest['collector']['ipSource'];
}

interface OsLike {
  hostname(): string;
  networkInterfaces(): Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;
}

/**
 * Who collected, on which machine and from which address (Berkeley Protocol ¶155(g)). Local state only: the address
 * is the configured egress IP (`OLCYS_COLLECTOR_IP`, e.g. a proxy) or the first non-internal IPv4 interface address.
 * No IP-echo service is ever called.
 */
export function resolveCollectorIdentity(env: Record<string, string | undefined>, os: OsLike): CollectorIdentity {
  const name = env['OLCYS_COLLECTOR_NAME']?.trim() || 'olcys-worker';
  const host = os.hostname();
  const configured = env['OLCYS_COLLECTOR_IP']?.trim();
  if (configured) {
    if (isIP(configured) === 0) throw new Error('OLCYS_COLLECTOR_IP is not a valid IP address');
    return { name, host, ip: configured, ipSource: 'configured' };
  }
  const interfaces = os.networkInterfaces();
  for (const iface of Object.keys(interfaces).toSorted()) {
    for (const entry of interfaces[iface] ?? []) {
      // Node reports the family as 'IPv4' (or 4 on some versions).
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        return { name, host, ip: entry.address, ipSource: 'local_interface' };
      }
    }
  }
  return { name, host, ipSource: 'unknown' };
}
