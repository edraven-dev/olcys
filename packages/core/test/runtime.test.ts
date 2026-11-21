import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  canonicalJson,
  ContractError,
  CreateCaseSchema,
  dAdd,
  dCmp,
  dDiv,
  DenyListSchema,
  dMul,
  dRound,
  dSum,
  fromBaseUnits,
  isAddressValuedProperty,
  isChainId,
  isUuidV7,
  newId,
  parse,
  RuleSetSchema,
  SourcesConfigSchema,
  toBaseUnits,
  toJsonSchema,
  WeightsConfigSchema,
} from '../src/index.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const loadYaml = (rel: string): unknown => parseYaml(readFileSync(join(repoRoot, rel), 'utf8'));

describe('ids', () => {
  it('generates RFC 9562 v7 ids that sort by creation time', () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(ids.every(isUuidV7)).toBe(true);
    expect(ids.toSorted()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('decimals', () => {
  it('is exact', () => {
    expect(dAdd('0.1', '0.2')).toBe('0.3');
    expect(dMul('1520.37', '4.0712')).toBe('6189.730344');
    expect(dDiv('1', '3', 6)).toBe('0.333333');
    expect(dRound('2.345', 2)).toBe('2.35');
    expect(dCmp('10', '9.99')).toBe(1);
    expect(dSum(['1500', '2000', '1500'])).toBe('5000');
  });
  it('converts base units both ways', () => {
    expect(fromBaseUnits('150000000', 8)).toBe('1.5');
    expect(fromBaseUnits(10n ** 16n, 18)).toBe('0.01');
    expect(toBaseUnits('0.01', 18)).toBe(10n ** 16n);
    expect(() => toBaseUnits('0.000000001', 8)).toThrow(RangeError);
  });
});

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ z: { y: 2, x: 1 }, u: undefined })).toBe('{"z":{"x":1,"y":2}}');
  });
  it('serialises numbers like ECMAScript', () => {
    expect(canonicalJson([1e21, 1e-7, -0, 0.1, 333333333.3333333])).toBe('[1e+21,1e-7,0,0.1,333333333.3333333]');
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });
});

describe('schemas', () => {
  it('validates chain ids', () => {
    expect(isChainId('evm:1')).toBe(true);
    expect(isChainId('evm:unknown')).toBe(true);
    expect(isChainId('zcash')).toBe(true);
    expect(isChainId('evm:abc')).toBe(false);
    expect(isChainId('evm')).toBe(false);
  });

  it('reports the failing path', () => {
    let caught: unknown;
    try {
      parse(CreateCaseSchema, {
        title: 'Sprawa testowa',
        purpose: 'Weryfikacja syntetycznej persony',
        legalBasis: 'demo',
        identifiers: [{ kind: 'crypto_address', value: 'x', chain: 'evm:abc' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractError);
    expect((caught as ContractError).issues.map((i) => i.path)).toContain('identifiers.0.chain');
  });

  it('applies defaults to case input', () => {
    const input = parse(CreateCaseSchema, {
      title: 'Kacper Fikcyjny',
      purpose: 'Weryfikacja syntetycznej persony',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
    });
    expect(input.scope.maxPivotDepth).toBe(2);
    expect(input.identifiers[0]?.isAnchor).toBe(true);
  });

  it('parses the committed config files', () => {
    const sources = parse(SourcesConfigSchema, loadYaml('config/sources.yaml'));
    expect(sources.sources['x_twitter']?.compliance).toBe('RED');
    const weights = parse(WeightsConfigSchema, loadYaml('config/scoring/weights.v1.yaml'));
    expect(weights.reliability.F).toBeNull();
    expect(weights.scales.enfsi.at(-1)?.maxLr).toBe(Number.POSITIVE_INFINITY);
    for (const file of ['config/rules/exclusion.v1.yaml', 'config/rules/cashout.v1.yaml']) {
      expect(parse(RuleSetSchema, loadYaml(file)).version).toMatch(/\.v1$/);
    }
    const denyList = parse(DenyListSchema, loadYaml('config/rules/deny-list.v1.yaml'));
    expect(denyList.version).toBe('deny-list.v1');
    expect(denyList.entries.length).toBeGreaterThan(0);
  });

  it('rejects a RED source enabled by default', () => {
    const config = loadYaml('config/sources.yaml') as { sources: Record<string, Record<string, unknown>> };
    const xTwitter = config.sources['x_twitter'];
    if (xTwitter) xTwitter['enabledByDefault'] = true;
    expect(() => parse(SourcesConfigSchema, config)).toThrow(ContractError);
  });

  it('exports JSON Schema', () => {
    const schema = toJsonSchema(CreateCaseSchema);
    expect(schema['type']).toBe('object');
  });
});

describe('vocabulary', () => {
  it('recognises address-valued properties', () => {
    for (const p of [
      'profile.bitcoin_address',
      'post.signed_message.address',
      'claim.drips.ethereum_address',
      'page.address',
      'post.address_mention[2]',
    ]) {
      expect({ p, valid: isAddressValuedProperty(p) }).toEqual({ p, valid: true });
    }
    for (const p of [
      'registry.business_location',
      'computed.signed_message_check',
      'profile.website',
      'registry.address',
    ]) {
      expect({ p, valid: isAddressValuedProperty(p) }).toEqual({ p, valid: false });
    }
  });
});

describe('browser safety', () => {
  it('core sources import no node: modules', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const offenders = readdirSync(dir).filter((file) => /from 'node:/.test(readFileSync(join(dir, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
