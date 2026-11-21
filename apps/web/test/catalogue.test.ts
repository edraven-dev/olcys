/**
 * The console imports only types from `@olcys/core`; these tests keep its local lists and catalogue in step with
 * the core value lists and the scoring configuration.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHANGE_KINDS,
  ENTITY_CATEGORIES,
  EXCLUSION_RULE_IDS,
  IDENTIFIER_KINDS,
  isAddressValuedProperty as coreIsAddressValued,
  KNOWN_CHAINS,
  LINK_GATE_IDS,
  NOT_ASSESSED,
  RELATIONS,
  RUN_STEPS,
} from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { RUN_STEP_ORDER } from '../src/features/run/run-model.ts';
import { pl } from '../src/i18n/pl.ts';
import { CONSOLE_CHAINS } from '../src/lib/chains.ts';
import { isAddressValuedProperty } from '../src/lib/domain.ts';

const weights = readFileSync(
  fileURLToPath(new URL('../../../config/scoring/weights.v1.yaml', import.meta.url)),
  'utf8',
);

describe('catalogue completeness', () => {
  it('lists the pipeline steps in core order', () => {
    expect(RUN_STEP_ORDER).toEqual([...RUN_STEPS]);
  });

  it('covers identifier kinds, relations, categories, rules and change kinds from core', () => {
    expect(Object.keys(pl.identifierKinds)).toEqual([...IDENTIFIER_KINDS]);
    expect(Object.keys(pl.relations).toSorted()).toEqual([...RELATIONS].toSorted());
    expect(Object.keys(pl.categories).toSorted()).toEqual([...ENTITY_CATEGORIES].toSorted());
    expect(Object.keys(pl.rejected.rules)).toEqual([...EXCLUSION_RULE_IDS]);
    expect(Object.keys(pl.changes.kinds)).toEqual([...CHANGE_KINDS]);
    for (const gate of LINK_GATE_IDS) expect(pl.gates[gate]).toBeTruthy();
    expect(pl.icd203[NOT_ASSESSED]).toBe('nie oceniono');
  });

  it('mirrors the core chain list', () => {
    expect(CONSOLE_CHAINS.map((c) => [c.id, c.nativeAsset])).toEqual(KNOWN_CHAINS.map((c) => [c.id, c.nativeAsset]));
    for (const chain of KNOWN_CHAINS) expect(Object.keys(pl.chains)).toContain(chain.id);
  });

  it('labels every feature of weights.v1.yaml and uses its Polish ICD 203 terms', () => {
    const features = [...weights.matchAll(/^ {4}([a-z0-9_]+):/gm)].map((m) => m[1] ?? '');
    expect(features.length).toBeGreaterThan(10);
    for (const feature of features) expect(pl.features[feature]).toBeTruthy();
    for (const m of weights.matchAll(/term: ([a-z ]+), pl: '([^']+)'/g)) {
      expect(pl.icd203[m[1] ?? '']).toBe(m[2]);
    }
  });

  it('detects address-valued properties exactly like core', () => {
    const properties = [
      'profile.bitcoin_address',
      'profile.link',
      'post.address_mention',
      'post.signed_message.address',
      'claim.drips.ethereum_address',
      'verification.eth_address[2]',
      'computed.signed_message_check',
      'registry.business_location',
      'registry.address',
      'page.address',
      'profile.addresses',
    ];
    for (const property of properties)
      expect([property, isAddressValuedProperty(property)]).toEqual([property, coreIsAddressValued(property)]);
  });
});
