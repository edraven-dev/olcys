import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalisationTransform } from '@olcys/core';
import { bech32, bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { createDenyList, parseDenyList } from '../src/deny-list.ts';
import type { PatternId, RawCandidate, ValidatedCandidate } from '../src/pipeline-types.ts';
import { validateAddress } from '../src/validate/address.ts';
import { resolveOverlaps, validateCandidate } from '../src/validate/validate.ts';
import { bytes, gen, homoglyphOf } from './helpers.ts';

function raw(patternId: PatternId, value: string, transforms: NormalisationTransform[] = []): RawCandidate {
  const family = patternId === 'evm_hex' ? 'evm' : patternId === 'tron_base58' ? 'tron' : 'bitcoin';
  return {
    patternId,
    family,
    value,
    view: 'visible_text',
    nStart: 0,
    nEnd: value.length,
    span: { start: 0, end: value.length },
    raw: value,
    transforms,
  };
}

function ok(result: ReturnType<typeof validateCandidate>): ValidatedCandidate {
  if (!result.ok) throw new Error(`expected a valid candidate, got ${result.rejected.reason}`);
  return result.value;
}

function reason(result: ReturnType<typeof validateCandidate>): string {
  if (result.ok) throw new Error('expected a rejection');
  return result.rejected.reason;
}

describe('Bitcoin segwit (BIP-173 / BIP-350)', () => {
  // Valid mainnet vectors from BIP-350 (they appear only in tests).
  const valid: [string, string][] = [
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh'],
    ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'segwit_v1'],
    ['BC1SW50QGDZ25J', 'segwit_v16'],
    ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'segwit_v2'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'p2tr'],
  ];

  it.each(valid)('accepts %s as %s', (address, format) => {
    const v = ok(validateCandidate(raw('btc_bech32', address)));
    expect(v.format).toBe(format);
    expect(v.canonical).toBe(address.toLowerCase());
    expect(v.possibleChains).toEqual(['bitcoin']);
    expect(v.checksum.bits).toBe(30);
  });

  it('rejects v1+ in bech32 and v0 in bech32m with bech32_variant_mismatch', () => {
    const v1InBech32 = bech32.encode('bc', [1, ...bech32.toWords(bytes('vm1', 32))]);
    const v0InBech32m = bech32m.encode('bc', [0, ...bech32m.toWords(bytes('vm0', 20))]);
    expect(reason(validateCandidate(raw('btc_bech32', v1InBech32)))).toMatch(/^bech32_variant_mismatch/);
    expect(reason(validateCandidate(raw('btc_bech32', v0InBech32m)))).toMatch(/^bech32_variant_mismatch/);
  });

  it('rejects bad witness programs, versions and checksums', () => {
    const v0Short = bech32.encode('bc', [0, ...bech32.toWords(bytes('w16', 16))]);
    const v1Tiny = bech32m.encode('bc', [1, ...bech32m.toWords(bytes('w1', 1))]);
    const v17 = bech32m.encode('bc', [17, ...bech32m.toWords(bytes('w17', 32))]);
    expect(reason(validateCandidate(raw('btc_bech32', v0Short)))).toMatch(/^witness_program_invalid/);
    expect(reason(validateCandidate(raw('btc_bech32', v1Tiny)))).toMatch(/^witness_program_invalid/);
    expect(reason(validateCandidate(raw('btc_bech32', v17)))).toMatch(/^witness_program_invalid/);
    const good = gen.p2wpkh('cs');
    const broken = `${good.slice(0, -1)}${good.endsWith('q') ? 'p' : 'q'}`;
    expect(reason(validateCandidate(raw('btc_bech32', broken)))).toBe('checksum_invalid: bech32');
  });

  it('rejects mixed case and accepts the all-upper form', () => {
    const address = gen.p2wpkh('case');
    const mixed = `${address.slice(0, 10).toUpperCase()}${address.slice(10)}`;
    expect(reason(validateCandidate(raw('btc_bech32', mixed)))).toBe('mixed_case');
    expect(ok(validateCandidate(raw('btc_bech32', address.toUpperCase()))).canonical).toBe(address);
  });

  it('accepts generated P2WPKH, P2WSH and P2TR', () => {
    expect(ok(validateCandidate(raw('btc_bech32', gen.p2wpkh('g1')))).format).toBe('p2wpkh');
    expect(ok(validateCandidate(raw('btc_bech32', gen.p2wsh('g2')))).format).toBe('p2wsh');
    expect(ok(validateCandidate(raw('btc_bech32', gen.p2tr('g3')))).format).toBe('p2tr');
  });
});

describe('Bitcoin base58check', () => {
  it('accepts a generated P2PKH and rejects every single-character substitution', () => {
    const address = gen.p2pkh('b58');
    const v = ok(validateCandidate(raw('btc_base58', address)));
    expect(v).toMatchObject({ format: 'p2pkh', possibleChains: ['bitcoin', 'bitcoincash'] });
    expect(v.checksum).toEqual({ scheme: 'base58check', present: true, valid: true, bits: 32 });
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 1; i < address.length; i += 1) {
      const replacement = alphabet[(alphabet.indexOf(address[i] ?? '1') + 7) % alphabet.length] ?? '1';
      const mutated = `${address.slice(0, i)}${replacement}${address.slice(i + 1)}`;
      expect(reason(validateCandidate(raw('btc_base58', mutated)))).toMatch(
        /^(checksum_invalid: base58check|length_invalid)/,
      );
    }
  });

  it('lists the chains a P2SH address is valid on', () => {
    expect(ok(validateCandidate(raw('btc_base58', gen.p2sh('p2sh')))).possibleChains).toEqual([
      'bitcoin',
      'litecoin',
      'bitcoincash',
    ]);
  });
});

describe('EVM (EIP-55)', () => {
  it('accepts a checksummed address with one check bit per letter', () => {
    const address = gen.evm('evm');
    const v = ok(validateCandidate(raw('evm_hex', address)));
    const letters = (address.slice(2).match(/[a-fA-F]/g) ?? []).length;
    expect(v).toMatchObject({ format: 'evm_eip55', canonical: address.toLowerCase(), possibleChains: ['evm:unknown'] });
    expect(v.checksum).toEqual({ scheme: 'eip55', present: true, valid: true, bits: letters });
    expect(v.extras.eip55).toBe(address);
  });

  it('rejects a flipped letter case and treats all-lower as unchecksummed', () => {
    const address = gen.evm('evm-flip');
    const at = address.slice(2).search(/[a-fA-F]/) + 2;
    const char = address[at] ?? 'a';
    const flipped = `${address.slice(0, at)}${char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()}${address.slice(at + 1)}`;
    expect(reason(validateCandidate(raw('evm_hex', flipped)))).toBe('checksum_invalid: eip55');
    const lower = ok(validateCandidate(raw('evm_hex', address.toLowerCase())));
    expect(lower.format).toBe('evm_lower');
    expect(lower.checksum).toEqual({ scheme: 'none', present: false, valid: true, bits: 0 });
    expect(ok(validateCandidate(raw('evm_hex', `0x${address.slice(2).toUpperCase()}`))).format).toBe('evm_upper');
  });
});

describe('TRON', () => {
  it('accepts version 0x41 and exposes the hex form', () => {
    const address = gen.tron('tron');
    const v = ok(validateCandidate(raw('tron_base58', address)));
    expect(v).toMatchObject({ format: 'tron_base58', canonical: address, possibleChains: ['tron'] });
    expect(v.extras.tronHex).toMatch(/^41[0-9a-f]{40}$/);
  });
});

describe('gates', () => {
  it('rejects homoglyph-folded matches even when the folded string is valid', () => {
    const { clean, tampered } = homoglyphOf('gate-hg');
    const candidate = { ...raw('btc_bech32', clean, ['homoglyph_folded']), raw: tampered };
    const result = validateCandidate(candidate);
    expect(reason(result)).toBe(`homoglyph_detected: folds to ${clean}`);
    expect(result).toMatchObject({ ok: false, rejected: { raw: expect.stringContaining('\u{0430}') } });
  });

  it('accepts gap-joined matches only with a strong checksum and flags them for review', () => {
    expect(reason(validateCandidate(raw('evm_hex', gen.evmLower('gj'), ['gap_joined'])))).toBe(
      'gap_joined_weak_checksum',
    );
    const v = ok(validateCandidate(raw('btc_bech32', gen.p2wpkh('gj2'), ['gap_joined'])));
    expect(v.reviewRequired).toBe(true);
    expect(ok(validateCandidate(raw('evm_hex', gen.evm('gj3'), ['gap_joined']))).reviewRequired).toBe(true);
    expect(ok(validateCandidate(raw('btc_bech32', gen.p2wpkh('nfkc'), ['nfkc']))).reviewRequired).toBe(false);
  });
});

describe('deny list', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const denyList = parseDenyList(readFileSync(join(repoRoot, 'config/rules/deny-list.v1.yaml'), 'utf8'));

  it('loads the committed deny list and every entry is a valid address on its chain', () => {
    expect(denyList.version).toBe('deny-list.v1');
    const yaml = readFileSync(join(repoRoot, 'config/rules/deny-list.v1.yaml'), 'utf8');
    const addresses = [...yaml.matchAll(/address: '?([0-9A-Za-z]+)'?/g)].map((m) => m[1] ?? '');
    expect(addresses.length).toBe(denyList.size);
    for (const address of addresses) {
      const result = validateAddress(address);
      expect({ address, ok: result.ok }).toEqual({ address, ok: true });
    }
  });

  it('rejects documentation examples and test vectors as documentation_example', () => {
    const bip173 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(reason(validateCandidate(raw('btc_bech32', bip173.toUpperCase()), { denyList }))).toBe(
      'documentation_example: BIP-173 example P2WPKH address',
    );
    expect(
      reason(validateCandidate(raw('evm_hex', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), { denyList })),
    ).toMatch(/^documentation_example/);
    expect(validateCandidate(raw('btc_bech32', gen.p2wpkh('not-denied')), { denyList }).ok).toBe(true);
  });

  it('leaves burn addresses and token contracts to the exclusion rules', () => {
    const burn = gen.evmLower('burn');
    const list = createDenyList({
      version: 't',
      entries: [{ chain: 'evm:1', address: burn, kind: 'burn', name: 'Burn', source: 'https://example.org/' }],
    });
    expect(validateCandidate(raw('evm_hex', burn), { denyList: list }).ok).toBe(true);
    expect(list.find(burn, ['evm:56'])?.kind).toBe('burn');
  });
});

describe('overlap resolution', () => {
  it('keeps the strongest, longest candidate and drops rejections it covers', () => {
    const address = gen.p2wpkh('ov');
    const full = ok(validateCandidate(raw('btc_bech32', address)));
    const shorter = {
      ...full,
      nEnd: full.nEnd - 4,
      span: { start: 0, end: address.length - 4 },
      checksum: { ...full.checksum, bits: 0 },
    };
    const rejection = {
      raw: address.slice(0, 30),
      reason: 'checksum_invalid: base58check',
      view: 'visible_text' as const,
      span: { start: 0, end: 30 },
    };
    const elsewhere = { ...rejection, span: { start: 100, end: 130 } };
    const result = resolveOverlaps([shorter, full], [rejection, elsewhere]);
    expect(result.valid).toEqual([full]);
    expect(result.rejected).toEqual([elsewhere]);
  });
});

describe('validateAddress', () => {
  it('validates single addresses and honours a chain hint', () => {
    const evm = gen.evm('va');
    expect(validateAddress(` ${evm} `)).toMatchObject({
      ok: true,
      address: { chain: 'evm:unknown', address: evm.toLowerCase() },
    });
    expect(validateAddress(evm, 'evm:56')).toMatchObject({ ok: true, address: { chain: 'evm:56' } });
    expect(validateAddress(gen.p2sh('va'), 'litecoin')).toMatchObject({ ok: true, address: { chain: 'litecoin' } });
    expect(validateAddress(gen.tron('va'), 'bitcoin')).toMatchObject({ ok: false });
    expect(validateAddress('not an address')).toEqual({ ok: false, reason: 'unsupported_format' });
  });
});
