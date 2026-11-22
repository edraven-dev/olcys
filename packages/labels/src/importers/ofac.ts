/**
 * OFAC SDN crypto addresses as published per asset by the 0xB10C extractor (`sanctioned_addresses_<ASSET>.json`,
 * public-domain data). Sanction status is an attribute; the category stays `sanctioned_entity` here and a delisted
 * address keeps its history through `activeFrom` / `activeTo` (a delisted mixer stays a mixer via TagPacks).
 */
import type { AddressLabel, ChainId, IsoDate } from '@olcys/core';
import { addressKey } from '@olcys/core';
import { makeLabel, validAddress, type ImportContext, type ImportResult } from './common.ts';

export const OFAC_ENTITY = 'OFAC SDN list';

const ASSET_CHAINS: Record<string, ChainId> = {
  XBT: 'bitcoin',
  ETH: 'evm:1',
  TRX: 'tron',
  LTC: 'litecoin',
  BCH: 'bitcoincash',
  BSC: 'evm:56',
  ARB: 'evm:42161',
  SOL: 'solana',
  XMR: 'monero',
};
const TOKEN_ASSETS = new Set(['USDT', 'USDC']);

/** Chains an asset file can contain; the caller scopes the previous version to them before diffing. */
export function ofacAssetChains(asset: string): ChainId[] {
  const a = asset.toUpperCase();
  if (TOKEN_ASSETS.has(a)) return ['evm:1', 'tron', 'solana'];
  const chain = ASSET_CHAINS[a];
  return chain ? [chain] : [];
}

function chainOf(asset: string, address: string): ChainId | undefined {
  const a = asset.toUpperCase();
  if (TOKEN_ASSETS.has(a)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm:1';
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return 'tron';
    if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(address)) return 'solana';
    return undefined;
  }
  return ASSET_CHAINS[a];
}

export function parseOfacList(asset: string, json: string, ctx: ImportContext): ImportResult<AddressLabel> {
  const warnings: string[] = [];
  const list: unknown = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error(`ofac ${asset}: expected a JSON array of addresses`);
  if (ofacAssetChains(asset).length === 0) {
    return { rows: [], warnings: [`ofac: asset ${asset} is not supported, skipped`] };
  }
  const rows: AddressLabel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const address = typeof item === 'string' ? item.trim() : '';
    const chain = address ? chainOf(asset, address) : undefined;
    if (!chain || !validAddress(chain, address)) {
      warnings.push(`ofac ${asset}: ${address || String(item)} is not a valid address, skipped`);
      continue;
    }
    const label = makeLabel(ctx, {
      chain,
      address,
      entity: OFAC_ENTITY,
      category: 'sanctioned_entity',
      confidence: 100,
      attributes: { sanctioned: true },
    });
    if (seen.has(addressKey(label.address))) continue;
    seen.add(addressKey(label.address));
    rows.push(label);
  }
  return { rows, warnings };
}

const dayBefore = (date: IsoDate): IsoDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Versions of the list: every address in `next` is active from the first snapshot it was seen in (`prev` carries
 * it), and an address that was active in `prev` but is gone from `next` is ended the day before `snapshotDate`.
 * Rows of `prev` that already ended are kept as they are. `next` rows must carry the snapshot's provenance.
 */
export function diffOfacVersions(
  prev: readonly AddressLabel[] | undefined,
  next: readonly AddressLabel[],
  snapshotDate: IsoDate,
): AddressLabel[] {
  const previous = prev ?? [];
  const activeBefore = new Map(
    previous.filter((l) => l.attributes.activeTo === undefined).map((l) => [addressKey(l.address), l]),
  );
  const out: AddressLabel[] = next.map((label) => {
    const before = activeBefore.get(addressKey(label.address));
    return { ...label, attributes: { ...label.attributes, activeFrom: before?.attributes.activeFrom ?? snapshotDate } };
  });
  const nextKeys = new Set(next.map((l) => addressKey(l.address)));
  const lastmod = next[0]?.provenance.lastmod ?? `${snapshotDate}T00:00:00.000Z`;
  for (const label of previous) {
    const key = addressKey(label.address);
    if (label.attributes.activeTo !== undefined) {
      out.push(label);
    } else if (!nextKeys.has(key)) {
      out.push({
        ...label,
        attributes: { ...label.attributes, activeTo: dayBefore(snapshotDate) },
        provenance: { ...label.provenance, version: snapshotDate, lastmod },
      });
    }
  }
  return out;
}
