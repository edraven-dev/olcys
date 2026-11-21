import { describe, expect, it } from 'vitest';
import { normaliseView } from '../src/normalise/normalise.ts';
import { scanView } from '../src/patterns/scan.ts';
import { gen, plainView, viewsOf } from './helpers.ts';

const fullwidth = (s: string): string =>
  [...s].map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c)).join('');

function scan(text: string) {
  const view = plainView(text);
  return scanView(view, normaliseView(view));
}

describe('candidate patterns', () => {
  const samples = [
    ['btc_bech32', gen.p2wpkh('p1')],
    ['btc_bech32', gen.p2tr('p2')],
    ['btc_base58', gen.p2pkh('p3')],
    ['btc_base58', gen.p2sh('p4')],
    ['evm_hex', gen.evm('p5')],
    ['tron_base58', gen.tron('p6')],
  ] as const;

  it.each(samples)('%s matches a generated sample with exact offsets', (patternId, address) => {
    const text = `Adres: ${address}.`;
    const { candidates } = scan(text);
    const hit = candidates.find((c) => c.patternId === patternId);
    expect(hit).toMatchObject({ value: address, nStart: 7, nEnd: 7 + address.length, raw: address });
  });

  it.each(samples)('%s matches a fullwidth sample and quotes the original text', (patternId, address) => {
    const shown = fullwidth(address);
    const { candidates } = scan(`(${shown})`);
    const hit = candidates.find((c) => c.patternId === patternId);
    expect(hit?.value).toBe(address);
    expect(hit?.raw).toBe(shown);
    expect(hit?.transforms).toEqual(['nfkc']);
  });

  it('never matches inside longer tokens: 0x+64 hex is a hash, 0x+41 hex nothing', () => {
    const hash = gen.txHash('h1');
    const r1 = scan(`tx ${hash}`);
    expect(r1.candidates.filter((c) => c.patternId === 'evm_hex')).toEqual([]);
    expect(r1.hashes.map((h) => h.value)).toEqual([hash]);
    const r2 = scan(`${gen.evmLower('h2')}a`);
    expect(r2.candidates).toEqual([]);
  });

  it('does not match IPFS CIDs', () => {
    const cidV0 = gen.cidV0('cid');
    const cidV1 = gen.cidV1('cid');
    expect(cidV0).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(cidV1).toMatch(/^bafy[a-z2-7]{55}$/);
    expect(scan(`${cidV0} ${cidV1}`).candidates).toEqual([]);
  });
});

describe('gap joiner', () => {
  it('joins an address split into 4-character groups', () => {
    const address = gen.p2wpkh('gap');
    const groups = address.match(/.{1,4}/g) ?? [];
    const { candidates } = scan(`Wpłać na: ${groups.join(' ')}`);
    const joined = candidates.filter((c) => c.transforms.includes('gap_joined') && c.value === address);
    expect(joined).toHaveLength(1);
    expect(joined[0]?.joinedParts).toBe(groups.length);
  });

  it('joins an address split by <br> in inline_joined', () => {
    const address = gen.p2wpkh('gap-br');
    const groups = address.match(/.{1,4}/g) ?? [];
    const view = viewsOf(`<p>${groups.join('<br>')}</p>`).inline_joined;
    if (!view) throw new Error('no view');
    const { candidates } = scanView(view, normaliseView(view));
    expect(candidates.some((c) => c.value === address && c.joinedParts === groups.length)).toBe(true);
  });

  it('never joins across containers', () => {
    const address = gen.p2wpkh('gap-li');
    const groups = address.match(/.{1,4}/g) ?? [];
    const view = viewsOf(`<ul>${groups.map((g) => `<li>${g}</li>`).join('')}</ul>`).visible_text;
    if (!view) throw new Error('no view');
    const { candidates } = scanView(view, normaliseView(view));
    expect(candidates.some((c) => c.value === address)).toBe(false);
  });
});
