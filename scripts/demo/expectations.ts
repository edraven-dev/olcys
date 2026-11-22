/**
 * Loads `fixtures/demo/manifest.json` (the single source of truth for the demo's expected values) and resolves its
 * address slots against the persona manifest, so addresses live in one place only.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export interface Slot {
  slot: string;
  /** Lower-case, for comparison. */
  address: string;
  /** As published (checksum case). */
  display: string;
}

export interface Expectations {
  v1: {
    links: (Slot & { score: number })[];
    rejected: (Slot & { rule: string })[];
    zeroScore: Slot[];
    cashOut: (Slot & { rule: string })[];
  };
  v2: {
    links: (Slot & { score: number })[];
    changes: { kind: string; property: string; from: Slot; to: Slot }[];
  };
  /** Every known slot by lower-case address, for labelling results. */
  slotOf: Map<string, string>;
  addressOf(slot: string): Slot;
}

interface RawManifest {
  addressesFrom: string;
  expected: {
    v1: {
      links: { slot: string; score: number }[];
      rejected: { slot: string; rule: string }[];
      zeroScore: string[];
      cashOut: { slot: string; rule: string }[];
    };
    v2: {
      links: { slot: string; score: number }[];
      changes: { kind: string; property: string; from: string; to: string }[];
    };
  };
}

export async function loadExpectations(root: string = REPO_ROOT): Promise<Expectations> {
  const raw = JSON.parse(await readFile(join(root, 'fixtures/demo/manifest.json'), 'utf8')) as RawManifest;
  const persona = JSON.parse(await readFile(join(root, raw.addressesFrom), 'utf8')) as {
    addresses: Record<string, { address: string }>;
  };
  const slotOf = new Map<string, string>();
  for (const [slot, { address }] of Object.entries(persona.addresses)) slotOf.set(address.toLowerCase(), slot);
  const addressOf = (slot: string): Slot => {
    const entry = persona.addresses[slot];
    if (!entry) throw new Error(`demo manifest names an unknown address slot: ${slot}`);
    return { slot, address: entry.address.toLowerCase(), display: entry.address };
  };
  const e = raw.expected;
  return {
    v1: {
      links: e.v1.links.map((l) => ({ ...addressOf(l.slot), score: l.score })),
      rejected: e.v1.rejected.map((r) => ({ ...addressOf(r.slot), rule: r.rule })),
      zeroScore: e.v1.zeroScore.map(addressOf),
      cashOut: e.v1.cashOut.map((c) => ({ ...addressOf(c.slot), rule: c.rule })),
    },
    v2: {
      links: e.v2.links.map((l) => ({ ...addressOf(l.slot), score: l.score })),
      changes: e.v2.changes.map((c) => ({
        kind: c.kind,
        property: c.property,
        from: addressOf(c.from),
        to: addressOf(c.to),
      })),
    },
    slotOf,
    addressOf,
  };
}
