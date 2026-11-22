/**
 * EIP-7702 delegation designators and the reference registries (delegates, EntryPoints) read from `config/labels/`:
 * real entries need a primary-source URL, only synthetic demo entries may name another source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDelegate, loadDelegateRegistry, loadEntryPoints, parseDelegation } from '../src/index.ts';

const read = (rel: string): string => readFileSync(join(import.meta.dirname, '..', '..', '..', rel), 'utf8');
const delegates = (entries: string): string => `version: test\ndelegates:\n${entries}`;
const entry = (fields: string): string =>
  delegates(`  - { chain: evm:1, address: '0x${'c1'.repeat(20)}', ${fields} }\n`);

describe('parseDelegation', () => {
  it('reads the 20-byte delegate after 0xef0100 and refuses other lengths', () => {
    expect(parseDelegation(`0xef0100${'ab'.repeat(20)}`)).toEqual({ delegate: `0x${'ab'.repeat(20)}` });
    expect(parseDelegation(`0xEF0100${'AB'.repeat(20)}`)).toEqual({ delegate: `0x${'ab'.repeat(20)}` });
    expect(parseDelegation(`0xef0100${'ab'.repeat(21)}`)).toBe('malformed');
    expect(parseDelegation(`0xef0100${'ab'.repeat(19)}`)).toBe('malformed');
    expect(parseDelegation('0xef0100')).toBe('malformed');
    expect(parseDelegation(`0xef0100${'zz'.repeat(20)}`)).toBe('malformed');
    expect(parseDelegation('0x6080604052')).toBeUndefined();
    expect(parseDelegation('0xef0001')).toBeUndefined();
    expect(parseDelegation('0x')).toBeUndefined();
  });
});

describe('delegate registry', () => {
  it('loads the repository registry: the synthetic sweeper only', () => {
    const registry = loadDelegateRegistry(read('config/labels/eip7702-delegates.v1.yaml'));
    expect([...registry.values()]).toEqual([
      {
        chain: 'evm:1',
        address: '0x2b5712612396864a3b6db2fd30c5a0169ec1e34b',
        kind: 'sweeper',
        name: 'SWEEPER-1 (SYNTHETIC)',
        source: 'synthetic demo entry (OŁCyŚ), not a real contract',
        synthetic: true,
      },
    ]);
    expect(findDelegate(registry, 'evm:1', '0x2B5712612396864A3B6dB2fD30c5A0169eC1E34B')?.kind).toBe('sweeper');
    expect(findDelegate(registry, 'evm:137', '0x2b5712612396864a3b6db2fd30c5a0169ec1e34b')).toBeUndefined();
  });

  it('applies an evm:unknown entry on every EVM network, after the network’s own entry', () => {
    const address = `0x${'c0'.repeat(20)}`;
    const registry = loadDelegateRegistry(
      delegates(
        `  - { chain: evm:unknown, address: '${address}', kind: wallet_implementation, name: Any, source: 'https://example.org/a' }\n` +
          `  - { chain: evm:10, address: '${address}', kind: sweeper, name: Op, source: 'https://example.org/b' }\n`,
      ),
    );
    expect(findDelegate(registry, 'evm:8453', address)?.name).toBe('Any');
    expect(findDelegate(registry, 'evm:10', address)?.name).toBe('Op');
  });

  it('refuses real entries without a primary-source URL and malformed entries', () => {
    expect(() => loadDelegateRegistry(entry("kind: sweeper, name: X, source: 'reported on social media'"))).toThrow(
      /https URL/,
    );
    expect(() => loadDelegateRegistry(entry("kind: sweeper, name: X, source: 'http://example.org'"))).toThrow(
      /https URL/,
    );
    expect(() => loadDelegateRegistry(entry("kind: drainer, name: X, source: 'https://example.org'"))).toThrow(
      /kind drainer unknown/,
    );
    expect(() => loadDelegateRegistry(entry("kind: sweeper, source: 'https://example.org'"))).toThrow(/name missing/);
    expect(() =>
      loadDelegateRegistry(delegates("  - { chain: tron, address: '0x00', kind: sweeper, name: X, source: x }\n")),
    ).toThrow(/EVM chain id/);
    const twice = `  - { chain: evm:1, address: '0x${'c2'.repeat(20)}', kind: sweeper, name: X, source: 'https://example.org' }\n`;
    expect(() => loadDelegateRegistry(delegates(twice + twice))).toThrow(/listed twice/);
    expect(() => loadDelegateRegistry('delegates: []')).toThrow(/missing version/);
  });
});

describe('EntryPoint registry', () => {
  it('loads v0.6–v0.9 lower-case, each with its release-notes source', () => {
    expect([...loadEntryPoints(read('config/labels/erc4337-entrypoints.v1.yaml'))]).toEqual([
      '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
      '0x0000000071727de22e5e9d8baf0edac6f37da032',
      '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
      '0x433709009b8330fda32311df1c2afa402ed8d009',
    ]);
    expect(() =>
      loadEntryPoints(`version: x\nentryPoints:\n  - { version: '1', address: '0x${'e0'.repeat(20)}' }\n`),
    ).toThrow(/https URL/);
  });
});
