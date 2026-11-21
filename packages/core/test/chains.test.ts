import { describe, expect, it } from 'vitest';
import { addressKey, chainFamily, KNOWN_CHAINS } from '../src/index.ts';

describe('chains', () => {
  it('derives the family of EVM network ids', () => {
    expect(chainFamily('evm:1')).toBe('evm');
    expect(chainFamily('evm:unknown')).toBe('evm');
    expect(chainFamily('bitcoin')).toBe('bitcoin');
  });

  it('builds stable address keys', () => {
    expect(addressKey({ chain: 'tron', address: 'TExample' })).toBe('tron:TExample');
  });

  it('has unique chain ids', () => {
    const ids = KNOWN_CHAINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
