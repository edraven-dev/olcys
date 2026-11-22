/**
 * eth-labels (MIT repository; the data was scraped from Etherscan, so its licence is unknown and it never decides).
 * Reads the SQLite file `accounts(chain_id, address, label, name_tag)` with `node:sqlite`, read-only.
 */
import { DatabaseSync } from 'node:sqlite';
import type { AddressLabel, EntityCategory } from '@olcys/core';
import { isChainId } from '@olcys/core';
import { makeLabel, validAddress, type ImportContext, type ImportResult } from './common.ts';

const EXCHANGE_BRANDS = [
  'binance',
  'bitfinex',
  'bitget',
  'bitstamp',
  'bybit',
  'coinbase',
  'crypto-com',
  'gate-io',
  'gemini',
  'htx',
  'huobi',
  'kraken',
  'kucoin',
  'mexc',
  'okx',
  'okex',
  'bitpanda',
  'upbit',
];

const SLUG_CATEGORY: Record<string, EntityCategory> = {
  ...Object.fromEntries(EXCHANGE_BRANDS.map((b) => [b, 'exchange' as const])),
  exchange: 'exchange',
  dex: 'defi_dex',
  '1inch': 'defi_dex',
  '0x-protocol': 'defi_dex',
  'curve-fi': 'defi_dex',
  'cow-protocol': 'defi_dex',
  bridge: 'bridge',
  stargate: 'bridge',
  'across-protocol': 'bridge',
  wormhole: 'bridge',
  changenow: 'instant_exchanger',
  'tornado-cash': 'mixer',
  mixer: 'mixer',
  payments: 'payment_gateway',
};

export function readEthLabels(sqlitePath: string, ctx: ImportContext): ImportResult<AddressLabel> {
  if (ctx.deciding) throw new Error('eth-labels never decides: import it with deciding false');
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const records = db.prepare('SELECT chain_id, address, label, name_tag FROM accounts').all() as {
      chain_id: number | bigint;
      address: string;
      label: string;
      name_tag: string | null;
    }[];
    const rows: AddressLabel[] = [];
    const unknownSlugs = new Map<string, number>();
    const warnings: string[] = [];
    for (const r of records) {
      const slug = String(r.label).trim().toLowerCase();
      const category = SLUG_CATEGORY[slug];
      if (!category) {
        unknownSlugs.set(slug, (unknownSlugs.get(slug) ?? 0) + 1);
        continue;
      }
      const chain = `evm:${Number(r.chain_id)}`;
      if (!isChainId(chain) || !validAddress(chain, r.address)) {
        warnings.push(`eth-labels: invalid chain or address (${chain}, ${r.address}), skipped`);
        continue;
      }
      rows.push(
        makeLabel(ctx, {
          chain,
          address: r.address,
          entity: r.name_tag?.trim() || slug,
          category,
          confidence: 50,
          attributes: category === 'exchange' ? { custodial: true } : {},
        }),
      );
    }
    for (const [slug, count] of unknownSlugs)
      warnings.push(`eth-labels: unknown slug ${slug} (${count} row(s)) skipped`);
    return { rows, warnings };
  } finally {
    db.close();
  }
}
