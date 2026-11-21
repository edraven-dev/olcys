import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base64, bech32, createBase58check, hex } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonaManifest } from '../src/manifest.ts';
import { check, generate, pathsFor, type Paths } from '../scripts/generate.ts';

let paths: Paths;
let manifest: PersonaManifest;

beforeAll(async () => {
  paths = pathsFor(await mkdtemp(join(tmpdir(), 'olcys-fixtures-')));
  manifest = await generate(paths, new Date('2026-11-21T00:00:00Z'));
});

const isEip55 = (address: string): boolean => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  const digest = hex.encode(keccak_256(new TextEncoder().encode(body.toLowerCase())));
  return [...body].every(
    (ch, i) =>
      /\d/.test(ch) || (Number.parseInt(digest[i] ?? '0', 16) >= 8 ? ch === ch.toUpperCase() : ch === ch.toLowerCase()),
  );
};

const validAddress = (a: PersonaManifest['addresses'][string]): boolean => {
  try {
    if (a.format === 'p2wpkh' || a.format === 'bip173_vector') {
      const decoded = bech32.decode(a.address as `${string}1${string}`);
      return (
        decoded.prefix === 'bc' && decoded.words[0] === 0 && bech32.fromWords(decoded.words.slice(1)).length === 20
      );
    }
    if (a.format === 'eip55') return isEip55(a.address);
    if (a.format === 'tron_base58') {
      const bytes = createBase58check(sha256).decode(a.address);
      return bytes.length === 21 && bytes[0] === 0x41;
    }
    return true;
  } catch {
    return false;
  }
};

describe('generator', () => {
  it('creates valid, distinct addresses for every slot', () => {
    const entries = Object.entries(manifest.addresses);
    expect(entries.filter(([, a]) => !validAddress(a)).map(([slot]) => slot)).toEqual([]);
    const values = entries.map(([, a]) => a.address.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
    expect(manifest.listing).toHaveLength(55);
    expect(manifest.listing[23]).toMatchObject({ line: 24, slot: 'HOT-1' });
  });

  it('signs SIG-1 for BTC-1 (independent BIP-137 recovery)', () => {
    const sig = manifest.signedMessages[0]!;
    const recover = (message: string): string => {
      const bytes = base64.decode(sig.signature);
      const body = new TextEncoder().encode(message);
      const digest = sha256(
        sha256(Uint8Array.of(...new TextEncoder().encode('\x18Bitcoin Signed Message:\n'), body.length, ...body)),
      );
      const pub = secp256k1.recoverPublicKey(Uint8Array.of((bytes[0] ?? 0) - 39, ...bytes.subarray(1)), digest, {
        prehash: false,
      });
      return bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(pub)))]);
    };
    expect(sig.header).toBeGreaterThanOrEqual(39);
    expect(recover(sig.message)).toBe(manifest.addresses['BTC-1']?.address);
    expect(recover(sig.message.replace('2026', '2025'))).not.toBe(manifest.addresses['BTC-1']?.address);
    expect(sig.message).toContain(manifest.addresses['BTC-1']?.address);
  });

  it('writes test vectors whose expectations hold', async () => {
    const vectors = JSON.parse(await readFile(join(paths.personaDir, 'test-vectors.json'), 'utf8')) as {
      vectors: { id: string; expected: string }[];
    };
    expect(vectors.vectors.map((v) => [v.id, v.expected])).toEqual([
      ['p2wpkh', 'valid'],
      ['p2wpkh_electrum', 'valid'],
      ['p2pkh_compressed', 'valid'],
      ['p2sh_p2wpkh', 'valid'],
      ['tampered_message', 'invalid'],
      ['wrong_address', 'invalid'],
      ['bip322_like', 'unsupported_format'],
      ['malformed', 'unsupported_format'],
      ['crlf', 'valid'],
    ]);
  });

  it('places the homoglyph decoy so that it fails bech32 and folds back to BTC-HG', () => {
    const d3 = manifest.addresses['D3']!.address;
    expect(d3).toContain('а');
    expect(() => bech32.decode(d3 as `${string}1${string}`)).toThrow(/./);
    expect(d3.replace('а', 'a')).toBe(manifest.addresses['BTC-HG']?.address);
  });

  it('detects drift after a manual edit', async () => {
    expect(await check(paths)).toEqual([]);
    const file = join(paths.publicDir, 'shared', 'robots.txt');
    await writeFile(file, 'User-agent: *\nDisallow:\n');
    expect(await check(paths)).toEqual(['changed: public/shared/robots.txt']);
  });

  it('keeps every synthetic balance non-negative', async () => {
    const { readdir } = await import('node:fs/promises');
    const chainDir = join(paths.publicDir, 'shared', 'chain');
    const all = (await readdir(chainDir, { recursive: true })).map(String);
    const read = async (rel: string) =>
      JSON.parse(await readFile(join(chainDir, rel), 'utf8')) as Record<string, unknown>;
    const balances = await Promise.all(all.filter((f) => f.endsWith('balance.json')).map(read));
    expect(balances.filter((b) => BigInt(String(b['result'])) < 0n)).toEqual([]);
    const stats = await Promise.all(all.filter((f) => f.startsWith('esplora') && f.endsWith('index.json')).map(read));
    const overspent = stats.filter((d) => {
      const c = d['chain_stats'] as { funded_txo_sum: number; spent_txo_sum: number };
      return c.funded_txo_sum < c.spent_txo_sum;
    });
    expect(overspent).toEqual([]);
  });

  it('writes demo labels for the exchange and DEX slots', async () => {
    const labels = JSON.parse(await readFile(join(paths.labelsDir, 'demo-curated.json'), 'utf8')) as {
      labels: { address: { address: string }; category: string }[];
    };
    expect(labels.labels.map((l) => [l.address.address, l.category])).toEqual([
      [manifest.addresses['HOT-1']?.address, 'exchange'],
      [manifest.addresses['TRON-HOT']?.address, 'exchange'],
      [manifest.addresses['TRON-DEX']?.address, 'defi_dex'],
    ]);
  });
});
