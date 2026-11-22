/** Persona-like input for the link graph: the persona links plus a github account, an exchange deposit and flows. */
import type { ActivityIndicators, Identifier, OnlineAccount } from '@olcys/core';
import type { ExclusionView, LinkView } from '../../src/lib/domain.ts';
import type { GraphInput } from '../../src/features/graph/build-elements.ts';
import {
  accounts as personaAccounts,
  btcLink,
  depositExclusion,
  ETH_1,
  ethWeakLink,
  identity,
  RUN_ID,
  thirdPartyLink,
  tronLink,
} from './persona.ts';

export const EXCHANGE = 'Giełda Przykładowa';

const identifier = (id: string, kind: Identifier['kind'], value: string, platform?: string): Identifier => ({
  ...identity,
  id,
  kind,
  value,
  isAnchor: false,
  ...(platform ? { platform } : {}),
});

export const identifiers: Identifier[] = [
  identifier('ident-name', 'full_name', 'Kacper Fikcyjny'),
  identity,
  identifier('ident-mail', 'email', 'kacper@example.invalid'),
];

export const githubAccount: OnlineAccount = {
  id: 'acc-gh',
  runId: RUN_ID,
  platform: 'github',
  handle: 'fikcyjny-kacper',
  profileUrl: 'http://127.0.0.1:4100/github/fikcyjny-kacper',
  discoveredVia: { sourceId: 'fixture_site', method: 'search' },
};

export const channelAccount: OnlineAccount = {
  id: 'acc-channel',
  runId: RUN_ID,
  platform: 'telegram',
  handle: 'kanal_fikcyjny',
  profileUrl: 'http://127.0.0.1:4100/telegram/kanal_fikcyjny',
  discoveredVia: { sourceId: 'fixture_site', method: 'cross_link' },
};

export const accounts: OnlineAccount[] = [...personaAccounts, githubAccount, channelAccount];

/** The subject's own account published an exchange deposit address: a KYC lead, not a holding. */
export const exchangeLink: LinkView = {
  ...btcLink,
  id: 'link-eth1',
  address: { chain: 'evm:1', address: ETH_1 },
  relation: 'CUSTODIAL_EXCHANGE',
  tier: 'E2',
  probability: 0,
  score: 0,
  icd203: 'not assessed',
  gates: [{ gate: 'relation', passed: false }],
};

/** Third-party attribution reported by the channel account. */
export const thirdParty: LinkView = {
  ...thirdPartyLink,
  paths: [{ ...btcLink.paths[0]!, accountId: 'acc-channel', probability: 0 }],
};

export const exclusion: ExclusionView = {
  ...depositExclusion,
  evidence: {
    ...depositExclusion.evidence,
    forwardsTo: { address: '0xhot', entity: EXCHANGE, category: 'exchange', labelId: 'label-1' },
  },
};

export const activity: ActivityIndicators = {
  address: { chain: 'evm:1', address: ETH_1 },
  window: {},
  txCount: 3,
  volumeIn: { native: '1' },
  volumeOut: { native: '1' },
  counterpartyCount: 1,
  serviceInteractions: [
    { category: 'exchange', entity: EXCHANGE, direction: 'out', count: 1, pln: '1520.37' },
    { category: 'exchange', entity: EXCHANGE, direction: 'out', count: 1, pln: '479.63' },
  ],
  swaps: [],
  cashOut: { events: [], score: 0 },
  computedAt: '2026-11-21T00:00:00Z',
  rulesVersion: 'cashout.v1',
};

export const links: LinkView[] = [btcLink, tronLink, ethWeakLink, exchangeLink, thirdParty];

export const graphInput: GraphInput = {
  caseTitle: 'Sprawa testowa',
  identifiers,
  accounts,
  links,
  exclusions: [exclusion],
  activity: [activity],
};
