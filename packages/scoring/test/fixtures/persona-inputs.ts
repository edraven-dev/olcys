/**
 * Synthetic run inputs mirroring the fixture site's persona pages (addresses and the signed message come from
 * fixtures/persona/manifest.json): what collectors and the address extractor produce for them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AddressCandidate,
  AdmiraltyReliability,
  Capture,
  ChainId,
  ChecksumInfo,
  ExclusionDecision,
  Identifier,
  Observation,
  OnlineAccount,
  RoleCue,
  SourceDescriptor,
} from '@olcys/core';
import type { FeatureExtractionInput } from '../../src/index.ts';

interface Manifest {
  addresses: Record<string, { chain: ChainId; address: string }>;
  signedMessages: { address: string; message: string; signature: string }[];
  expected: {
    v1: { links: { slot: string; score: number | null }[] };
    v2: { links: { slot: string; score: number }[] };
  };
}

export const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'persona', 'manifest.json'), 'utf8'),
) as Manifest;

export function slot(name: string): { chain: ChainId; address: string } {
  const a = MANIFEST.addresses[name];
  if (!a) throw new Error(`manifest has no slot ${name}`);
  return a;
}

const AT = '2026-11-21T10:00:00.000Z';
const RUN = 'run-persona';
const BT = 'https://bitcointalk.org/index.php';
export const URLS = {
  profile: `${BT}?action=profile;u=900001`,
  staking: `${BT}?topic=5500001.0`,
  deposit: `${BT}?topic=5500002.0`,
  wykop: 'https://wykop.pl/ludzie/fikcyjny_kacper/',
  tablica: 'https://tablica.example.org/ogloszenie/81000001/',
  github: 'https://github.com/fikcyjny-kacper/gas-tracker-cli',
  funding: 'https://raw.githubusercontent.com/fikcyjny-kacper/gas-tracker-cli/HEAD/FUNDING.json',
  telegram: 'https://t.me/s/olcys_test_ostrzezenia',
} as const;

const CHECKSUMS: Record<string, ChecksumInfo> = {
  bitcoin: { scheme: 'bech32', present: true, valid: true, bits: 30 },
  'evm:1': { scheme: 'eip55', present: true, valid: true, bits: 15 },
  tron: { scheme: 'base58check', present: true, valid: true, bits: 32 },
};

function identifier(id: string, kind: Identifier['kind'], value: string, extra: Partial<Identifier> = {}): Identifier {
  return { id, caseId: 'case-persona', kind, value, isAnchor: false, addedAt: AT, addedBy: 'analityk', ...extra };
}

function account(
  id: string,
  platform: string,
  handle: string,
  profileUrl: string,
  extra: Partial<OnlineAccount> = {},
): OnlineAccount {
  return {
    id,
    runId: RUN,
    platform,
    handle,
    profileUrl,
    discoveredVia: { sourceId: 'fixture_site', method: 'cross_link' },
    ...extra,
  };
}

export function capture(id: string, url: string, extra: Partial<Capture> = {}): Capture {
  return {
    id,
    runId: RUN,
    sourceId: 'fixture_site',
    url,
    finalUrl: url,
    collectedAt: AT,
    collector: 'test',
    clockSynced: true,
    toolVersion: 'test',
    userAgent: 'test',
    httpStatus: 200,
    status: 'ok',
    artifacts: [],
    manifestSha256: '0'.repeat(64),
    fetchIds: [`fetch-${id}`],
    ...extra,
  };
}

let observationSeq = 0;
function obs(
  captureId: string,
  subject: Observation['subject'],
  property: string,
  value: string,
  locator = `${subject.key}#${property}`,
): Observation {
  observationSeq += 1;
  return {
    id: `obs-${String(observationSeq).padStart(3, '0')}`,
    runId: RUN,
    captureId,
    sourceId: 'fixture_site',
    subject,
    property,
    value,
    locator,
    observedAt: AT,
  };
}

const acct = (key: string): Observation['subject'] => ({ type: 'account', key });
const page = (key: string): Observation['subject'] => ({ type: 'page', key });

export function candidate(
  id: string,
  captureId: string,
  slotName: string,
  roleCues: RoleCue[],
  extra: { anchor?: string; inCode?: boolean; label?: string; density?: number; reviewRequired?: boolean } = {},
): AddressCandidate {
  const ref = slot(slotName);
  const evm = ref.chain.startsWith('evm:');
  return {
    id,
    captureId,
    raw: ref.address,
    address: { chain: ref.chain, address: evm ? ref.address.toLowerCase() : ref.address },
    format: ref.chain === 'bitcoin' ? 'p2wpkh' : evm ? 'evm_eip55' : 'tron_base58',
    checksum: CHECKSUMS[ref.chain] ?? { scheme: 'none', present: false, valid: true, bits: 0 },
    chainAttribution: { method: evm ? 'keyword' : 'format_unique' },
    view: extra.inCode ? 'code' : 'visible_text',
    span: { start: 0, end: ref.address.length },
    transforms: [],
    context: {
      snippet: '(SYNTHETIC)',
      ...(extra.label ? { label: extra.label } : {}),
      inCode: extra.inCode ?? false,
      roleCues,
      pageAddressDensity: extra.density ?? 1,
      occurrencesInCapture: 1,
      ...(extra.anchor ? { anchor: extra.anchor } : {}),
    } as AddressCandidate['context'],
    reviewRequired: extra.reviewRequired ?? false,
  };
}

export interface PersonaOptions {
  variant?: 'v1' | 'v2';
  signature?: string;
  exclusions?: ExclusionDecision[];
  llmSuggestionsExcluded?: number;
  /** Register grade per source id (default B). */
  grades?: Record<string, AdmiraltyReliability>;
}

export function personaInputs(opts: PersonaOptions = {}): FeatureExtractionInput {
  observationSeq = 0;
  const sig = MANIFEST.signedMessages[0];
  if (!sig) throw new Error('manifest without a signed message');
  const profileSlot = opts.variant === 'v2' ? 'BTC-2' : 'BTC-1';

  const identifiers = [
    identifier('idf-1', 'nickname', 'fikcyjny_kacper', { platform: 'bitcointalk', isAnchor: true }),
    identifier('idf-2', 'full_name', 'Kacper Fikcyjny'),
    identifier('idf-3', 'email', 'kacper.fikcyjny@example.org'),
  ];
  const accounts = [
    account('acc-bt-persona', 'bitcointalk', 'fikcyjny_kacper', URLS.profile, {
      platformUserId: '900001',
      discoveredVia: { sourceId: 'fixture_site', method: 'input' },
    }),
    account('acc-bt-verifier', 'bitcointalk', 'test_weryfikator', `${BT}?action=profile;u=900002`, {
      platformUserId: '900002',
    }),
    account('acc-bt-moderator', 'bitcointalk', 'test_moderator', `${BT}?action=profile;u=900003`, {
      platformUserId: '900003',
    }),
    account('acc-wykop', 'wykop', 'fikcyjny_kacper', 'https://wykop.pl/ludzie/fikcyjny_kacper', {
      discoveredVia: { sourceId: 'fixture_site', method: 'enumeration', captureId: 'cap-wykop' },
    }),
    account('acc-tablica', 'tablica', 'fikcyjny_kacper', URLS.tablica, {
      displayName: 'Kacper Fikcyjny',
      discoveredVia: { sourceId: 'fixture_site', method: 'search', captureId: 'cap-tablica' },
    }),
    account('acc-github', 'github', 'fikcyjny-kacper', 'https://github.com/fikcyjny-kacper', {
      discoveredVia: { sourceId: 'fixture_site', method: 'enumeration' },
    }),
    account('acc-telegram', 'telegram', 'olcys_test_ostrzezenia', URLS.telegram, {
      discoveredVia: { sourceId: 'fixture_site', method: 'search', captureId: 'cap-telegram' },
    }),
  ];
  const captures = [
    capture('cap-profile', URLS.profile),
    capture('cap-staking', URLS.staking),
    capture('cap-deposit', URLS.deposit),
    capture('cap-wykop', URLS.wykop),
    capture('cap-tablica', URLS.tablica),
    capture('cap-github', URLS.github),
    capture('cap-funding', URLS.funding),
    capture('cap-telegram', URLS.telegram),
  ];
  const signed = 'bitcointalk:msg=65000001';
  const observations = [
    obs('cap-profile', acct('bitcointalk:900001'), 'profile.name', 'fikcyjny_kacper'),
    obs('cap-profile', acct('bitcointalk:900001'), 'profile.bitcoin_address', slot(profileSlot).address),
    obs('cap-profile', acct('bitcointalk:900001'), 'profile.website', 'https://example.org/'),
    obs('cap-staking', page(signed), 'post.author', 'bitcointalk:900001'),
    obs('cap-staking', page('bitcointalk:msg=65000002'), 'post.author', 'bitcointalk:900002'),
    obs(
      'cap-staking',
      acct('bitcointalk:900001'),
      'post.signed_message.address',
      sig.address,
      `${signed}#signed_message[0]`,
    ),
    obs(
      'cap-staking',
      acct('bitcointalk:900001'),
      'post.signed_message.text',
      sig.message,
      `${signed}#signed_message[0]`,
    ),
    obs(
      'cap-staking',
      acct('bitcointalk:900001'),
      'post.signed_message.signature',
      opts.signature ?? sig.signature,
      `${signed}#signed_message[0]`,
    ),
    obs('cap-deposit', page('bitcointalk:msg=65000101'), 'post.author', 'bitcointalk:900001'),
    obs('cap-deposit', page('bitcointalk:msg=65000102'), 'post.author', 'bitcointalk:900003'),
    obs('cap-deposit', page('bitcointalk:msg=65000103'), 'post.author', 'bitcointalk:900001'),
    obs('cap-deposit', page('bitcointalk:msg=65000104'), 'post.author', 'bitcointalk:900001'),
    obs('cap-wykop', acct('wykop:fikcyjny_kacper'), 'account.link', URLS.profile, 'wykop:fikcyjny_kacper#link[0]'),
    obs('cap-tablica', acct('tablica:fikcyjny_kacper'), 'profile.name', 'Kacper Fikcyjny'),
    obs('cap-tablica', acct('tablica:fikcyjny_kacper'), 'profile.email', 'kacper.fikcyjny@example.org'),
    obs('cap-funding', acct('github:fikcyjny-kacper'), 'claim.drips.ethereum_address', slot('ETH-2').address),
    obs('cap-telegram', page('telegram:olcys_test_ostrzezenia/101'), 'post.author', 'telegram:olcys_test_ostrzezenia'),
  ];
  const listing = ['LISTING-01', 'LISTING-02', 'HOT-1'].map((name, i) =>
    candidate(`cand-listing-${i}`, 'cap-deposit', name, ['listing'], { anchor: 'msg65000102', density: 57 }),
  );
  const found: { captureId: string; candidates: AddressCandidate[] }[] = [
    {
      captureId: 'cap-profile',
      candidates: [candidate('cand-profile', 'cap-profile', profileSlot, ['unclear'], { label: 'Bitcoin address:' })],
    },
    {
      captureId: 'cap-staking',
      candidates: [
        candidate('cand-staking', 'cap-staking', 'BTC-1', ['unclear'], { anchor: 'msg65000001', inCode: true }),
      ],
    },
    {
      captureId: 'cap-deposit',
      candidates: [
        candidate('cand-eth1', 'cap-deposit', 'ETH-1', ['exchange_deposit'], { anchor: 'msg65000101' }),
        candidate('cand-contract', 'cap-deposit', 'CONTRACT-1', ['unclear'], { anchor: 'msg65000104' }),
        ...listing,
      ],
    },
    {
      captureId: 'cap-wykop',
      candidates: [
        candidate('cand-wykop', 'cap-wykop', 'TRON-1', ['first_person_owner'], { label: 'mój portfel USDT TRC20:' }),
      ],
    },
    {
      captureId: 'cap-tablica',
      candidates: [candidate('cand-tablica', 'cap-tablica', 'TRON-1', ['first_person_owner', 'payment_request'])],
    },
    { captureId: 'cap-funding', candidates: [candidate('cand-funding', 'cap-funding', 'ETH-2', ['unclear'])] },
    {
      captureId: 'cap-telegram',
      candidates: [candidate('cand-tron2', 'cap-telegram', 'TRON-2', ['scam_report', 'warning'])],
    },
  ];
  const extractions = found.map(({ captureId, candidates }) => ({
    captureId,
    candidates,
    rejected: [],
    secrets: [],
    extractorVersion: 'test',
  }));

  const sources = (id: string): SourceDescriptor | undefined => ({
    id,
    name: id,
    kind: 'fixture',
    compliance: 'GREEN',
    complianceNote: 'synthetic',
    namePl: id,
    complianceNotePl: 'syntetyczne',
    tosUrl: null,
    enabledByDefault: true,
    requiresApiKey: false,
    sendsIdentifiersExternally: false,
    reliability: opts.grades?.[id] ?? 'B',
    rateLimit: { requests: 1, perSeconds: 1 },
    allowedHosts: [],
  });

  return {
    runId: RUN,
    identifiers,
    accounts,
    captures,
    observations,
    extractions,
    sources,
    exclusions: opts.exclusions ?? [],
    ...(opts.llmSuggestionsExcluded ? { llmSuggestionsExcluded: opts.llmSuggestionsExcluded } : {}),
  };
}

export function exclusion(
  slotName: string,
  ruleId: ExclusionDecision['ruleId'],
  extra: Partial<ExclusionDecision> = {},
): ExclusionDecision {
  const ref = slot(slotName);
  return {
    id: `ex-${slotName}-${ruleId}`,
    runId: RUN,
    address: { chain: ref.chain, address: ref.chain.startsWith('evm:') ? ref.address.toLowerCase() : ref.address },
    ruleId,
    outcome: 'excluded',
    reason: 'synthetic rule decision',
    evidence: {},
    rulesVersion: 'exclusion.v1',
    ...extra,
  };
}
