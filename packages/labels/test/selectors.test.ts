/** The hard-coded selectors and storage slots of the probes, recomputed with keccak-256. */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { ERC1967_IMPLEMENTATION_SLOT, SAFE_SINGLETON_SLOT, SELECTORS } from '../src/index.ts';

const keccak = (text: string): string => bytesToHex(keccak_256(utf8ToBytes(text)));

describe('probe selectors and slots', () => {
  it('each selector is the first 4 bytes of keccak-256 of its signature', () => {
    expect(SELECTORS).toEqual({
      entryPoint: `0x${keccak('entryPoint()').slice(0, 8)}`,
      totalSupply: `0x${keccak('totalSupply()').slice(0, 8)}`,
      decimals: `0x${keccak('decimals()').slice(0, 8)}`,
    });
  });

  it('the ERC-1967 implementation slot is keccak-256("eip1967.proxy.implementation") − 1', () => {
    const slot = BigInt(`0x${keccak('eip1967.proxy.implementation')}`) - 1n;
    expect(ERC1967_IMPLEMENTATION_SLOT).toBe(`0x${slot.toString(16).padStart(64, '0')}`);
    expect(SAFE_SINGLETON_SLOT).toBe('0x0');
  });
});
