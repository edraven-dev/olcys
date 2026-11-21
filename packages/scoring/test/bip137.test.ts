import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyBip137 } from '../src/index.ts';

interface Vector {
  id: string;
  address: string;
  message: string;
  signature: string;
  expected: 'valid' | 'invalid' | 'unsupported_format';
}

const REPO = join(import.meta.dirname, '..', '..', '..');
const load = async <T>(path: string): Promise<T> => JSON.parse(await readFile(join(REPO, path), 'utf8')) as T;

describe('verifyBip137', () => {
  it('matches every synthetic test vector (CRLF messages are also checked with LF)', async () => {
    const { vectors } = await load<{ vectors: Vector[] }>('fixtures/persona/test-vectors.json');
    expect(vectors.length).toBeGreaterThanOrEqual(9);
    expect(vectors.map((v) => [v.id, verifyBip137(v.address, v.message, v.signature)])).toEqual(
      vectors.map((v) => [v.id, v.expected]),
    );
  });

  it('verifies the persona staking signature and rejects a changed message', async () => {
    const manifest = await load<{ signedMessages: { address: string; message: string; signature: string }[] }>(
      'fixtures/persona/manifest.json',
    );
    const sig = manifest.signedMessages[0];
    if (!sig) throw new Error('fixture without a signed message');
    expect(verifyBip137(sig.address, sig.message, sig.signature)).toBe('valid');
    expect(verifyBip137(sig.address.toUpperCase(), sig.message, sig.signature)).toBe('valid');
    expect(verifyBip137(sig.address, sig.message.replace('2026', '2025'), sig.signature)).toBe('invalid');
  });

  it('reports address kinds BIP-137 cannot prove as unsupported', async () => {
    const { vectors } = await load<{ vectors: Vector[] }>('fixtures/persona/test-vectors.json');
    const v = vectors.find((x) => x.id === 'p2wpkh');
    if (!v) throw new Error('missing vector');
    const taproot = `bc1p${'q'.repeat(58)}`;
    expect(verifyBip137(taproot, v.message, v.signature)).toBe('unsupported_format');
  });
});
