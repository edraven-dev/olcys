/** Synthetic UTXO transactions for the co-spend tests: fake addresses and txids, values in BTC. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressLabel, UtxoTransaction } from '@olcys/core';
import { fromBaseUnits, newId } from '@olcys/core';
import { loadExclusionRules } from '../src/index.ts';

export const rules = loadExclusionRules(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'config', 'rules', 'exclusion.v1.yaml'), 'utf8'),
);

export const addr = (name: string): string => `bc1q-${name}`;
export const txid = (name: string): string => `tx-${name}`;

export interface TxOptions {
  height?: number;
  outputs?: { address?: string; sats: number; scriptType?: string }[];
  inputSats?: number;
  witnessScriptAsm?: Record<string, string>;
  prev?: Record<string, { txid: string; vout: number }>;
}

/** A confirmed transaction spending one input per `inputs` address. */
export function tx(name: string, inputs: string[], options: TxOptions = {}): UtxoTransaction {
  const outputs = options.outputs ?? [{ address: addr(`out-${name}`), sats: 50_000 }];
  return {
    chain: 'bitcoin',
    txid: txid(name),
    blockHeight: options.height ?? 100,
    blockTime: '2026-01-01T00:00:00.000Z',
    inputs: inputs.map((a, i) => ({
      address: a,
      value: fromBaseUnits(String(options.inputSats ?? 100_000), 8),
      prevTxid: options.prev?.[a]?.txid ?? `funding-${name}-${i}`,
      vout: options.prev?.[a]?.vout ?? 0,
      ...(options.witnessScriptAsm?.[a] ? { witnessScriptAsm: options.witnessScriptAsm[a] } : {}),
    })),
    outputs: outputs.map((o, n) => {
      const out: UtxoTransaction['outputs'][number] = { value: fromBaseUnits(String(o.sats), 8), n };
      if (o.address) out.address = o.address;
      if (o.scriptType) out.scriptType = o.scriptType;
      return out;
    }),
    fetchId: newId(),
  };
}

/** `count` outputs of `sats`, to distinct fresh addresses. */
export const equalOutputs = (name: string, count: number, sats: number) =>
  Array.from({ length: count }, (_, i) => ({ address: addr(`${name}-eq${i}`), sats }));

export function serviceLabel(address: string, id = newId()): AddressLabel {
  return {
    id,
    address: { chain: 'bitcoin', address },
    entity: 'Giełda Testowa (SYNTHETIC)',
    category: 'exchange',
    attributes: { custodial: true },
    provenance: {
      datasetId: 'test-por',
      url: 'https://example.invalid/por',
      license: 'CC0-1.0',
      lastmod: '2026-01-01T00:00:00Z',
      retrievedAt: '2026-01-01T00:00:00Z',
      sourceType: 'por_file',
      deciding: true,
      synthetic: true,
    },
    confidence: 95,
  };
}

/** Deterministic shuffle (no randomness in tests). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
