/**
 * Synthetic test data for the console (fictional persona "Kacper Fikcyjny"; addresses from the fixture generator).
 * Score values follow the weights.v1 arithmetic of the worked example (99 / 50 / 24).
 */
import type { Capture, ChangeEvent, FeatureContribution, HopResult, Identifier, OnlineAccount } from '@olcys/core';
import type { ExclusionView, LinkView } from '../../src/lib/domain.ts';

export const RUN_ID = '019a0000-0000-7000-8000-000000000001';
export const BTC_1 = 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2';
export const BTC_2 = 'bc1qgegxcs9wqknj3cnku7p3gqrkl67pmhljyeg6p3';
export const TRON_1 = 'TMVZLbhMuEYfsXYUzwWSarLmLPWJUmVPVk';
export const ETH_1 = '0xcd5c1a91d6dfaafeb0807e3c9d6d00655a54617a';
export const ETH_2 = '0xc3436335b60f0fd74bf6c2638f7a8fa64ac53cd7';
export const D3_HOMOGLYPH = 'bc1qsyrа8u0s8akk2qyh7kkqcfgrexw85n5aqmnhdv';

export const identity: Identifier = {
  id: 'ident-nick',
  caseId: 'case-1',
  kind: 'nickname',
  value: 'fikcyjny_kacper',
  platform: 'bitcointalk',
  isAnchor: true,
  addedAt: '2026-11-21T10:00:00.000Z',
  addedBy: 'analityk',
};

export const accounts: OnlineAccount[] = [
  {
    id: 'acc-btt',
    runId: RUN_ID,
    platform: 'bitcointalk',
    handle: 'fikcyjny_kacper',
    profileUrl: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001',
    discoveredVia: { sourceId: 'fixture_site', method: 'input' },
  },
  {
    id: 'acc-wykop',
    runId: RUN_ID,
    platform: 'wykop',
    handle: 'fikcyjny_kacper',
    profileUrl: 'http://127.0.0.1:4100/wykop/ludzie/fikcyjny_kacper/',
    discoveredVia: { sourceId: 'fixture_site', method: 'cross_link' },
  },
  {
    id: 'acc-tablica',
    runId: RUN_ID,
    platform: 'tablica',
    handle: 'fikcyjny_kacper',
    profileUrl: 'http://127.0.0.1:4100/tablica/ogloszenie/81000001/',
    discoveredVia: { sourceId: 'fixture_site', method: 'search' },
  },
];

export const capture: Capture = {
  id: 'cap-profile',
  runId: RUN_ID,
  sourceId: 'fixture_site',
  url: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001',
  finalUrl: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001',
  collectedAt: '2026-11-21T19:21:30.000Z',
  collector: 'dev-analyst',
  clockSynced: true,
  toolVersion: '0.1.0',
  userAgent: 'olcys-test',
  httpStatus: 200,
  status: 'ok',
  artifacts: [{ kind: 'html', blob: { sha256: 'a'.repeat(64), bytes: 12_345, mediaType: 'text/html' } }],
  manifestSha256: 'b'.repeat(64),
  fetchIds: [],
};

function contribution(
  hop: 'identity' | 'address',
  feature: string,
  bayesFactor: number,
  rho: number,
  counted = true,
  captureId = capture.id,
): FeatureContribution {
  const discounted = rho * bayesFactor + (1 - rho);
  return {
    hop,
    feature,
    reliability: rho >= 0.95 ? 'A' : rho >= 0.8 ? 'B' : 'C',
    originGroup: 'acct:bitcointalk:900001',
    evidence: { captureId },
    bayesFactor,
    rho,
    discountedBayesFactor: discounted,
    bits: Math.log2(discounted),
    counted,
  };
}

function hopResult(hop: 'identity' | 'address', priorBits: number, contributions: FeatureContribution[]): HopResult {
  const evidenceBits = contributions.filter((c) => c.counted).reduce((sum, c) => sum + c.bits, 0);
  const totalBits = priorBits + evidenceBits;
  return {
    hop,
    priorBits,
    contributions,
    totalBits,
    probability: 2 ** totalBits / (1 + 2 ** totalBits),
    likelihoodRatio: 2 ** evidenceBits,
    enfsiVerbal: 'very strong support',
  };
}

export const anchorHop = hopResult('identity', Math.log2(99), []);
export const btcAddressHop = hopResult('address', -2, [
  contribution('address', 'e1_cryptographic_binding', 1000, 0.95),
  contribution('address', 'e2_self_assertion', 32, 0.8),
  contribution('address', 'e3_bare_mention', 2, 0.6, false),
]);

const base = {
  runId: RUN_ID,
  identityId: identity.id,
  gates: [{ gate: 'relation', passed: true }],
  algorithmVersion: 'two-hop-llr.v1',
  weightsVersion: 'weights.v1',
  weightsSha256: 'c'.repeat(64),
  rulesVersion: 'relations.v1',
  computedAt: '2026-11-21T19:22:00.000Z',
  analyticConfidence: 'High' as const,
};

export const btcLink: LinkView = {
  ...base,
  id: 'link-btc1',
  address: { chain: 'bitcoin', address: BTC_1 },
  relation: 'SELF_DECLARED',
  tier: 'E1',
  paths: [
    {
      accountId: 'acc-btt',
      identityHop: anchorHop,
      addressHop: btcAddressHop,
      probability: 0.99 * btcAddressHop.probability,
    },
  ],
  probability: 0.9898,
  score: 99,
  icd203: 'almost certain',
};

const tronIdentity = hopResult('identity', -3.1699, [contribution('identity', 'exact_username_or_name', 3, 0.95)]);
const tronAddress = hopResult('address', -2, [contribution('address', 'e3_ownership_cue', 8, 0.6)]);

/** Two independent services (wykop + tablica): trace synergy without the engine's `synergy` field. */
export const tronLink: LinkView = {
  ...base,
  id: 'link-tron1',
  address: { chain: 'tron', address: TRON_1 },
  relation: 'PAYMENT_ENDPOINT',
  tier: 'E3',
  analyticConfidence: 'Moderate',
  paths: [
    { accountId: 'acc-wykop', identityHop: tronIdentity, addressHop: tronAddress, probability: 0.4 },
    { accountId: 'acc-tablica', identityHop: tronIdentity, addressHop: tronAddress, probability: 0.3 },
  ],
  probability: 0.58,
  score: 58,
  icd203: 'likely',
};

export const ethWeakLink: LinkView = {
  ...base,
  id: 'link-eth2',
  address: { chain: 'evm:1', address: ETH_2 },
  relation: 'SELF_DECLARED',
  tier: 'E2',
  analyticConfidence: 'Low',
  paths: [
    {
      accountId: 'acc-gh',
      identityHop: hopResult('identity', -3.1699, [contribution('identity', 'exact_username_or_name', 3, 0.95)]),
      addressHop: hopResult('address', -2, [contribution('address', 'e1_cryptographic_binding', 1000, 0.95)]),
      probability: 0.2427,
    },
  ],
  probability: 0.2427,
  score: 24,
  icd203: 'unlikely',
};

export const thirdPartyLink: LinkView = {
  ...base,
  id: 'link-tron2',
  address: { chain: 'tron', address: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu' },
  relation: 'THIRD_PARTY_ATTRIBUTION',
  tier: 'E4',
  paths: [],
  probability: 0,
  score: 0,
  icd203: 'not assessed',
  gates: [{ gate: 'relation', passed: false }],
};

export const depositExclusion: ExclusionView = {
  id: 'excl-eth1',
  runId: RUN_ID,
  address: { chain: 'evm:1', address: ETH_1 },
  ruleId: 'A4',
  outcome: 'reclassified',
  relation: 'CUSTODIAL_EXCHANGE',
  reason: 'A4: forwards 1 deposit to the labelled hot wallet within 12 blocks',
  evidence: { kappa: 0.9712, txHashes: ['0x' + '1'.repeat(64)] },
  rulesVersion: 'exclusion.v1',
};

export const walletSwap: ChangeEvent & { wallet: boolean } = {
  id: 'chg-1',
  runId: 'run-2',
  previousRunId: RUN_ID,
  kind: 'VALUE_CHANGED',
  key: {
    platform: 'fixture_site',
    locator: 'bitcointalk:u=900001#profile.bitcoin_address',
    property: 'profile.bitcoin_address',
  },
  before: BTC_1,
  after: BTC_2,
  beforeCaptureId: 'cap-v1',
  afterCaptureId: 'cap-v2',
  detectedAt: '2026-11-21T20:00:00.000Z',
  wallet: true,
};
