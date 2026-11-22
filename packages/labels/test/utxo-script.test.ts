/**
 * Bitcoin script types from the address encoding alone (synthetic addresses built here with bech32/bech32m and
 * base58check): no request is ever sent for a Bitcoin address.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { classifyAddress, loadSafeSingletons, MemoryLabelLookup, utxoScriptType } from '../src/index.ts';
import { ctx, scriptedProvider } from './helpers.ts';

const base58check = createBase58check(sha256);
const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill);
const segwit = (version: number, program: Uint8Array, encoding = version === 0 ? bech32 : bech32m, hrp = 'bc') =>
  encoding.encode(hrp, [version, ...bech32.toWords(program)]);
const legacy = (version: number, payload = bytes(20, 7)): string =>
  base58check.encode(Uint8Array.of(version, ...payload));

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'fixtures', 'persona', 'manifest.json'), 'utf8'),
) as { addresses: Record<string, { address: string }> };

describe('utxoScriptType', () => {
  it('reads segwit v0/v1 programs and legacy version bytes', () => {
    expect(utxoScriptType(segwit(0, bytes(20, 1)))).toBe('p2wpkh');
    expect(utxoScriptType(manifest.addresses['BTC-1']?.address ?? '')).toBe('p2wpkh');
    expect(utxoScriptType(segwit(0, bytes(32, 2)))).toBe('p2wsh');
    expect(utxoScriptType(segwit(1, bytes(32, 3)))).toBe('p2tr');
    expect(utxoScriptType(segwit(1, bytes(32, 3)).toUpperCase())).toBe('p2tr');
    expect(utxoScriptType(legacy(0x00))).toBe('p2pkh');
    expect(legacy(0x05).startsWith('3')).toBe(true);
    expect(utxoScriptType(legacy(0x05))).toBe('p2sh');
  });

  it('refuses wrong checksum variants, programs, networks and checksums', () => {
    // BIP-350: v0 must be bech32, v1+ bech32m
    expect(utxoScriptType(segwit(0, bytes(20, 1), bech32m))).toBe('unknown');
    expect(utxoScriptType(segwit(1, bytes(32, 3), bech32))).toBe('unknown');
    expect(utxoScriptType(segwit(0, bytes(24, 1)))).toBe('unknown');
    expect(utxoScriptType(segwit(1, bytes(20, 3)))).toBe('unknown');
    expect(utxoScriptType(segwit(2, bytes(32, 3)))).toBe('unknown');
    expect(utxoScriptType(segwit(0, bytes(20, 1), bech32, 'tb'))).toBe('unknown');
    expect(utxoScriptType(segwit(0, bytes(20, 1), bech32, 'ltc'))).toBe('unknown');
    const mixed = segwit(0, bytes(20, 1));
    expect(utxoScriptType(`${mixed.slice(0, 10).toUpperCase()}${mixed.slice(10)}`)).toBe('unknown');
    expect(utxoScriptType(legacy(0x6f))).toBe('unknown');
    expect(utxoScriptType(legacy(0x00, bytes(19, 7)))).toBe('unknown');
    const valid = legacy(0x00);
    expect(utxoScriptType(`${valid.slice(0, -1)}${valid.endsWith('z') ? 'y' : 'z'}`)).toBe('unknown');
    expect(utxoScriptType('')).toBe('unknown');
  });
});

describe('Bitcoin classification', () => {
  it('AC6: bc1q… is p2wpkh, bc1p… p2tr and 3… p2sh — with zero requests', async () => {
    const provider = scriptedProvider({});
    const deps = {
      provider,
      labels: new MemoryLabelLookup([]),
      safeSingletons: loadSafeSingletons(),
      entryPoints: new Set<string>(),
    };
    const cases = [
      [segwit(0, bytes(20, 1)), 'p2wpkh'],
      [segwit(1, bytes(32, 3)), 'p2tr'],
      [legacy(0x05), 'p2sh'],
    ] as const;
    for (const [address, scriptType] of cases) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await classifyAddress({ chain: 'bitcoin', address }, deps, ctx)).toEqual({
        address: { chain: 'bitcoin', address },
        type: 'utxo_script',
        scriptType,
        fetchIds: [],
      });
    }
    expect(await classifyAddress({ chain: 'bitcoin', address: legacy(0x6f) }, deps, ctx)).toMatchObject({
      type: 'unknown',
      fetchIds: [],
    });
    expect(provider.requests).toEqual([]);
  });
});
