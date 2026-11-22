import { readFileSync } from 'node:fs';
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

/** Interfaces that are virtual (container bridges, VPN and overlay devices), never the machine's own address. */
const VIRTUAL_INTERFACE = /^(docker|podman|br-|veth|virbr|cni|flannel|cali|tun|tap|wg|tailscale|zt|vmnet|vboxnet|lxc)/;

/**
 * The interface of the default IPv4 route (lowest metric) from `/proc/net/route`, or undefined when there is none or
 * the file cannot be read (not Linux). Local state only.
 */
export function readDefaultRouteInterface(
  read: () => string = () => readFileSync('/proc/net/route', 'utf8'),
): string | undefined {
  let text: string;
  try {
    text = read();
  } catch {
    return undefined;
  }
  let best: { iface: string; metric: number } | undefined;
  for (const line of text.split('\n').slice(1)) {
    const [iface, destination, , flags, , , metric] = line.trim().split(/\s+/);
    if (!iface || destination !== '00000000' || (Number.parseInt(flags ?? '0', 16) & 1) === 0) continue;
    const m = Number(metric);
    if (!best || m < best.metric) best = { iface, metric: m };
  }
  return best?.iface;
}

/**
 * Who collected, on which machine and from which address (Berkeley Protocol ¶155(g)). Local state only: the address
 * is the configured egress IP (`OLCYS_COLLECTOR_IP`, e.g. a proxy), the IPv4 address of the default-route interface, or
 * the first non-internal IPv4 address of a non-virtual interface.
 * No IP-echo service is ever called.
 */
export function resolveCollectorIdentity(
  env: Record<string, string | undefined>,
  os: OsLike,
  defaultRouteInterface?: string,
): CollectorIdentity {
  const name = env['OLCYS_COLLECTOR_NAME']?.trim() || 'olcys-worker';
  const host = os.hostname();
  const configured = env['OLCYS_COLLECTOR_IP']?.trim();
  if (configured) {
    if (isIP(configured) === 0) throw new Error('OLCYS_COLLECTOR_IP is not a valid IP address');
    return { name, host, ip: configured, ipSource: 'configured' };
  }
  const interfaces = os.networkInterfaces();
  const external = (iface: string) =>
    (interfaces[iface] ?? []).find((e) => (e.family === 'IPv4' || e.family === 4) && !e.internal);
  // The default-route interface is the machine's outward-facing one; otherwise the first physical-looking interface.
  const routed = defaultRouteInterface ? external(defaultRouteInterface) : undefined;
  if (routed) return { name, host, ip: routed.address, ipSource: 'local_interface' };
  for (const iface of Object.keys(interfaces).toSorted()) {
    if (VIRTUAL_INTERFACE.test(iface)) continue;
    for (const entry of interfaces[iface] ?? []) {
      // Node reports the family as 'IPv4' (or 4 on some versions).
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        return { name, host, ip: entry.address, ipSource: 'local_interface' };
      }
    }
  }
  return { name, host, ipSource: 'unknown' };
}
