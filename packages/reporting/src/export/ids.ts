/** Name-based UUIDs (RFC 4122 version 5: SHA-1 over namespace + name) without a dependency. */
import { createHash } from 'node:crypto';

/** Namespace of STIX 2.1 deterministic SCO identifiers (specification section 2.9). */
export const STIX_NAMESPACE = '00abedb4-aa42-466c-9c01-fed23315a9b7';

/** Fixed namespace of the identifiers of objects OŁCyŚ creates itself (SDOs, SROs, MISP objects). */
export const OLCYS_EXPORT_NAMESPACE = '6f1d5a1e-3a52-5c1b-8d0e-4b7a9c2e5f10';

export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Identifier of an object OŁCyŚ creates: stable for one report and natural key, so a re-export is identical. */
export const exportId = (reportId: string, key: string): string =>
  uuidv5(OLCYS_EXPORT_NAMESPACE, `${reportId}\u0000${key}`);
