import type { ChecksumInfo } from '@olcys/core';
import type { ClaimInput, PathInput } from '../../src/index.ts';
import { feature } from './helpers.ts';

/** The methodology's worked example (synthetic persona, weights v1/v2): 99 / 50 / 24, and 62 for two paths. */
export const BTC1_PATH: PathInput = {
  anchor: true,
  identity: [],
  address: [
    feature('address', 'e1_cryptographic_binding', 'A', 'acct:bitcointalk:900001'),
    feature('address', 'e2_self_assertion', 'B', 'acct:bitcointalk:900001'),
  ],
  service: 'bitcointalk',
  originGroup: 'acct:bitcointalk:900001',
};

export const TRON1_PATH: PathInput = {
  anchor: false,
  identity: [
    feature('identity', 'profile_link_to_anchor', 'B', 'acct:wykop:fikcyjny_kacper'),
    feature('identity', 'exact_username_or_name', 'A', 'acct:wykop:fikcyjny_kacper'),
  ],
  address: [feature('address', 'e3_ownership_cue', 'C', 'acct:wykop:fikcyjny_kacper')],
  service: 'wykop',
  originGroup: 'acct:wykop:fikcyjny_kacper',
};

export const ETH2_PATH: PathInput = {
  anchor: false,
  identity: [feature('identity', 'exact_username_or_name', 'A', 'acct:github:fikcyjny-kacper')],
  address: [feature('address', 'e1_cryptographic_binding', 'A', 'acct:github:fikcyjny-kacper')],
  service: 'github',
  originGroup: 'acct:github:fikcyjny-kacper',
};

export const BECH32: ChecksumInfo = { scheme: 'bech32', present: true, valid: true, bits: 30 };

export function claim(paths: PathInput[], extra: Partial<ClaimInput> = {}): ClaimInput {
  return {
    runId: 'run-1',
    identityId: 'identity-1',
    address: { chain: 'bitcoin', address: 'bc1qsynthetic0000000000000000000000000000' },
    relation: 'SELF_DECLARED',
    tier: 'E1',
    checksum: BECH32,
    paths,
    exclusions: [],
    reviewRequired: false,
    rulesVersion: 'relations.v1',
    ...extra,
  };
}

/** Expected values (tolerance 1e-6). */
export const VECTORS = {
  btc1: { addressBits: 12.581159, addressP: 0.99983684, lr: 24511.29, path: 0.98983847, score: 99 },
  tron1: {
    identityBits: 3.055427,
    identityP: 0.89262706,
    identityLr: 74.82,
    addressBits: 0.378512,
    addressP: 0.56521739,
    path: 0.50452834,
    score: 50,
  },
  eth2: {
    identityBits: -1.633872,
    identityP: 0.24369748,
    addressBits: 7.89186,
    addressP: 0.99580735,
    path: 0.24267574,
    score: 24,
  },
  combined: { probability: 0.62476729, score: 62 },
} as const;
