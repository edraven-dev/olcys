/**
 * Safe singletons from the pinned `@safe-global/safe-deployments`: every released version, Safe and SafeL2, every
 * deployment type, lower-case, per network.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSafeSingletons, SAFE_VERSIONS } from '../src/index.ts';

const singletons = loadSafeSingletons();

describe('loadSafeSingletons', () => {
  it('lists the canonical v1.3.0 and v1.4.1 singletons (Safe and SafeL2) on evm:1', () => {
    const mainnet = singletons.get('evm:1');
    for (const address of [
      '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
      '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
      '0x41675c099f32341bf84bfc5382af534df5c7461a',
      '0x29fcb43b46531bca003ddc8fcb67ffe91900c762',
    ]) {
      expect(mainnet?.has(address)).toBe(true);
    }
  });

  it('snapshot of evm:1: every released version, including the EIP-155 deployments', () => {
    expect([...(singletons.get('evm:1') ?? [])].toSorted()).toEqual([
      '0x29fcb43b46531bca003ddc8fcb67ffe91900c762',
      '0x34cfac646f301356faa8b21e94227e3583fe3f5f',
      '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
      '0x41675c099f32341bf84bfc5382af534df5c7461a',
      '0x6851d6fdfafd08c0295c392436245e5bc78b0185',
      '0x69f4d1788e39c87893c980c06edf4b7f686e2938',
      '0xb6029ea3b2c51d09a50b53ca8012feeb05bda35a',
      '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
      '0xedd160febbd92e350d4d398fb636302fccd67c7e',
      '0xfb1bffc9d739b8d520daf37df666da4c687191ea',
      '0xff51a5898e281db6dfc7855790607438df2ca44b',
    ]);
  });

  it('covers L2 networks and stores addresses lower-case', () => {
    expect(singletons.get('evm:10')?.has('0xfb1bffc9d739b8d520daf37df666da4c687191ea')).toBe(true);
    expect(singletons.get('evm:8453')?.has('0x29fcb43b46531bca003ddc8fcb67ffe91900c762')).toBe(true);
    expect(singletons.size).toBeGreaterThan(100);
    for (const [chain, set] of singletons) {
      expect(chain).toMatch(/^evm:\d+$/);
      for (const address of set) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it('knows every version the installed package ships', () => {
    const pkg = createRequire(import.meta.url).resolve('@safe-global/safe-deployments/package.json');
    const shipped = readdirSync(join(dirname(pkg), 'dist', 'assets'))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .map((name) => name.slice(1))
      .toSorted();
    expect([...SAFE_VERSIONS].toSorted()).toEqual(shipped);
  });
});
