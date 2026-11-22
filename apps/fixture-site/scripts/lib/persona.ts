/**
 * The synthetic demo persona: identities, addresses, signed message, decoys, pages, routes, labels and the expected
 * analysis outcome. Only BTC-1 gets a real key pair (to sign the staking message); every other address is random
 * bytes in a valid format. Keys are zeroised after use and never written.
 */
import { randomBytes } from 'node:crypto';
import type { ManifestAccount, ManifestAddress, ManifestPage, PersonaManifest } from '../../src/manifest.ts';
import type { Variant } from '../../src/resolve.ts';
import {
  DEMO_NOW,
  derive,
  renderChain,
  STORY_SLOTS,
  SYNTHETIC_MARK,
  USDT_TRC20,
  type FixtureRouteOut,
  type GeneratedFile,
} from './chain.ts';
import * as crypto from './crypto.ts';

export const PERSONA = {
  fullName: 'Kacper Fikcyjny',
  nick: 'fikcyjny_kacper',
  email: 'kacper.fikcyjny@example.org',
  bitcointalkUid: '900001',
  githubLogin: 'fikcyjny-kacper',
} as const;

/** BIP-173's own P2WPKH example: appears only as decoy D2 (documentation vector, deny list). */
export const BIP173_VECTOR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const CYRILLIC_A = 'а';

export const signedMessageFor = (btc1: string): string =>
  `I am fikcyjny_kacper (uid 900001) and I control ${btc1}. Date: 2026-11-01. SYNTHETIC TEST DATA - OLCYS fixture.`;

const SYNTHETIC_IDENTIFIERS = [
  PERSONA.fullName,
  PERSONA.nick,
  PERSONA.githubLogin,
  PERSONA.email,
  '@fikcyjny_kacper:example.org',
  '900001',
  '900002',
  '900003',
  'test_weryfikator',
  'test_moderator',
  'olcys_test_ostrzezenia',
  // Registry identifiers of the persona's firm (deliberately unassigned values).
  '0001234562',
  '001234562',
  '0009999901',
];

const HOST_PREFIXES: Record<string, string> = {
  'bitcointalk.org': '/bitcointalk',
  'wykop.pl': '/wykop',
  'github.com': '/github',
  'raw.githubusercontent.com': '/github-raw',
  't.me': '/telegram',
  'mempool.space/api': '/chain/esplora/api',
  'blockstream.info/api': '/chain/esplora/api',
  'api.etherscan.io/v2/api': '/chain/etherscan/v2/api',
  'api.trongrid.io': '/chain/trongrid',
  'dane.biznes.gov.pl/api/ceidg/v3': '/registries/ceidg/v3',
  'wykazpodatnikowvat.mf.gov.pl/api': '/registries/vat-whitelist/api',
  'api-krs.ms.gov.pl/api/krs': '/registries/krs/api',
};

const BT = '/bitcointalk/index.php';

const PAGES: ManifestPage[] = [
  {
    path: `${BT}?action=profile;u=900001`,
    file: 'bitcointalk/profile-900001.html',
    platform: 'bitcointalk',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['BTC-1', 'BTC-2'],
  },
  {
    path: `${BT}?action=profile;u=900001;sa=showPosts`,
    file: 'bitcointalk/showposts-900001.html',
    platform: 'bitcointalk',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['BTC-1', 'ETH-1', 'TX-DECOY', 'D2', 'CONTRACT-1'],
  },
  {
    path: `${BT}?topic=5500001.0`,
    file: 'bitcointalk/topic-5500001.html',
    platform: 'bitcointalk',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['BTC-1'],
  },
  {
    path: `${BT}?topic=5500002.0`,
    file: 'bitcointalk/topic-5500002.html',
    platform: 'bitcointalk',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['ETH-1', 'TX-DECOY', 'HOT-1', 'LISTING-*', 'D2', 'CONTRACT-1'],
  },
  {
    path: '/wykop/ludzie/fikcyjny_kacper/',
    file: 'wykop/ludzie/fikcyjny_kacper/index.html',
    platform: 'wykop',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['TRON-1'],
  },
  {
    path: '/tablica/ogloszenie/81000001/',
    file: 'tablica/ogloszenie/81000001/index.html',
    platform: 'tablica',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['TRON-1'],
  },
  {
    path: '/github/fikcyjny-kacper/',
    file: 'github/fikcyjny-kacper/index.html',
    platform: 'github',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: [],
  },
  {
    path: '/github/fikcyjny-kacper/gas-tracker-cli/',
    file: 'github/fikcyjny-kacper/gas-tracker-cli/index.html',
    platform: 'github',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['ETH-2'],
  },
  {
    path: '/github-raw/fikcyjny-kacper/gas-tracker-cli/HEAD/FUNDING.json',
    file: 'github-raw/fikcyjny-kacper/gas-tracker-cli/HEAD/FUNDING.json',
    platform: 'github',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['ETH-2'],
  },
  {
    path: '/telegram/s/olcys_test_ostrzezenia/',
    file: 'telegram/s/olcys_test_ostrzezenia/index.html',
    platform: 'telegram',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['TRON-2', 'D3'],
  },
  {
    path: '/private/',
    file: 'private/index.html',
    platform: 'fixture',
    sourceId: 'fixture_site',
    variants: ['v1', 'v2'],
    slots: ['BTC-CANARY'],
  },
];

const ACCOUNTS: ManifestAccount[] = [
  {
    platform: 'bitcointalk',
    handle: 'fikcyjny_kacper',
    uid: '900001',
    path: `${BT}?action=profile;u=900001`,
    role: 'persona',
  },
  {
    platform: 'wykop',
    handle: 'fikcyjny_kacper',
    path: '/wykop/ludzie/fikcyjny_kacper/',
    role: 'persona',
    linksTo: 'bitcointalk:900001',
    note: 'profile links to the forum profile',
  },
  {
    platform: 'tablica',
    handle: 'fikcyjny_kacper',
    path: '/tablica/ogloszenie/81000001/',
    role: 'persona',
    note: 'P2P classified ad with the full name and e-mail of the persona',
  },
  {
    platform: 'github',
    handle: 'fikcyjny-kacper',
    path: '/github/fikcyjny-kacper/',
    role: 'unrelated_same_nick',
    note: 'same nick, no name, bio or links: not the persona',
  },
  {
    platform: 'telegram',
    handle: 'olcys_test_ostrzezenia',
    path: '/telegram/s/olcys_test_ostrzezenia/',
    role: 'third_party',
    note: 'warning channel naming the persona',
  },
  {
    platform: 'bitcointalk',
    handle: 'test_weryfikator',
    uid: '900002',
    path: `${BT}?action=profile;u=900002`,
    role: 'third_party',
  },
  {
    platform: 'bitcointalk',
    handle: 'test_moderator',
    uid: '900003',
    path: `${BT}?action=profile;u=900003`,
    role: 'third_party',
  },
];

/** Expected analysis outcome. `roadmap` values are fixed; `derived` and `engine` ones are confirmed by the scorer. */
const EXPECTED = {
  weights: 'weights.v2',
  v1: {
    links: [
      {
        slot: 'BTC-1',
        score: 99,
        basis: 'roadmap',
        evidence: ['profile "Bitcoin address" field', 'BIP-137 signed message'],
      },
      {
        slot: 'TRON-1',
        score: 77,
        basis: 'engine',
        evidence: ['social-network post "mój portfel"', 'P2P classified ad with name and e-mail'],
        note: 'two independent sources (trace synergy); the scoring engine fixes the value',
      },
      { slot: 'ETH-2', score: 24, basis: 'roadmap', note: 'same nick on a code-hosting site, account unrelated' },
    ],
    rejected: [
      {
        slot: 'ETH-1',
        rule: 'A4',
        relation: 'CUSTODIAL_EXCHANGE',
        basis: 'roadmap',
        note: 'exchange deposit sweeping to HOT-1; interaction recorded',
      },
      { slot: 'HOT-1', rule: 'A1', basis: 'derived', note: 'labelled exchange hot wallet' },
      { slot: 'D2', rule: 'A8', basis: 'derived', note: 'BIP-173 documentation vector' },
      { slot: 'CONTRACT-1', rule: 'A2', basis: 'derived', note: 'eth_getCode returns bytecode' },
    ],
    noOwnershipClaim: [{ slot: 'TRON-2', relation: 'THIRD_PARTY_ATTRIBUTION', basis: 'roadmap' }],
    notCandidates: [{ slot: 'TX-DECOY', reason: 'transaction hash (64 hex digits)' }],
    homoglyph: [{ slot: 'D3', foldsTo: 'BTC-HG', outcome: 'homoglyph_detected or review_required', basis: 'derived' }],
    cashOut: [
      {
        rule: 'B1',
        slot: 'ETH-1',
        note: 'persona deposit of 1.5 ETH (tx D1) to an exchange deposit address',
        basis: 'roadmap',
      },
      {
        rule: 'B1',
        slot: 'TRON-1',
        note: '3000 USDT to TRON-DEP, which sweeps to the labelled TRON-HOT',
        basis: 'derived',
      },
      {
        rule: 'B4',
        slot: 'TRON-1',
        note: '5000 USDT from a DEX pair, 60 % sent to an exchange deposit within 2 days',
        basis: 'derived',
      },
      {
        rule: 'B5',
        slot: 'TRON-1',
        note: 'six round-number USDT transfers to unrelated addresses; matches the P2P ad',
        basis: 'derived',
      },
    ],
  },
  v2: {
    changes: [
      {
        kind: 'VALUE_CHANGED',
        locator: 'bitcointalk:u=900001#profile.bitcoin_address',
        from: 'BTC-1',
        to: 'BTC-2',
        basis: 'roadmap',
      },
    ],
    links: [
      { slot: 'BTC-2', score: 86, basis: 'derived', note: 'profile field only' },
      { slot: 'BTC-1', score: 99, basis: 'derived', note: 'signed message remains' },
    ],
  },
};

const LAST_ACTIVE: Record<Variant, string> = {
  v1: 'November 15, 2026, 06:40:12 PM',
  v2: 'November 20, 2026, 09:05:33 AM',
};

export interface TestVector {
  id: string;
  address: string;
  message: string;
  signature: string;
  expected: 'valid' | 'invalid' | 'unsupported_format';
  normalise?: 'crlf_to_lf';
  note: string;
}

export interface World {
  manifest: Omit<PersonaManifest, 'files'>;
  testVectors: { _synthetic: string; scheme: 'bip137'; vectors: TestVector[] };
}

function homoglyphOf(address: string): string {
  const index = address.indexOf('a', 3);
  return `${address.slice(0, index)}${CYRILLIC_A}${address.slice(index + 1)}`;
}

function makeTestVectors(): World['testVectors'] {
  const key = crypto.newKeyPair();
  const p2wpkh = crypto.p2wpkhAddress(key.publicKey33);
  const message = 'OLCYS signature test vector (SYNTHETIC TEST DATA)';
  const sign = (text: string, kind: crypto.Bip137Kind) => crypto.signBip137(key.secretKey, text, kind);
  const base = { address: p2wpkh, message };
  const vectors: TestVector[] = [
    { id: 'p2wpkh', ...base, signature: sign(message, 'p2wpkh'), expected: 'valid', note: 'BIP-137 header 39-42' },
    {
      id: 'p2wpkh_electrum',
      ...base,
      signature: sign(message, 'electrum'),
      expected: 'valid',
      note: 'Electrum header 31-34 for a segwit address (compat mode)',
    },
    {
      id: 'p2pkh_compressed',
      address: crypto.p2pkhAddress(key.publicKey33),
      message,
      signature: sign(message, 'p2pkh_compressed'),
      expected: 'valid',
      note: 'header 31-34',
    },
    {
      id: 'p2sh_p2wpkh',
      address: crypto.p2shP2wpkhAddress(key.publicKey33),
      message,
      signature: sign(message, 'p2sh_p2wpkh'),
      expected: 'valid',
      note: 'header 35-38',
    },
    {
      id: 'tampered_message',
      address: p2wpkh,
      message: message.replace('vector', 'vect0r'),
      signature: sign(message, 'p2wpkh'),
      expected: 'invalid',
      note: 'one character changed after signing',
    },
    {
      id: 'wrong_address',
      address: crypto.randomP2wpkhAddress(),
      message,
      signature: sign(message, 'p2wpkh'),
      expected: 'invalid',
      note: 'valid signature, different address',
    },
    {
      id: 'bip322_like',
      ...base,
      signature: randomBytes(110).toString('base64'),
      expected: 'unsupported_format',
      note: 'not a 65-byte BIP-137 signature',
    },
    { id: 'malformed', ...base, signature: 'not-base64!', expected: 'unsupported_format', note: 'not base64' },
    {
      id: 'crlf',
      address: p2wpkh,
      message: 'line one\r\nline two (SYNTHETIC)',
      signature: sign('line one\nline two (SYNTHETIC)', 'p2wpkh'),
      expected: 'valid',
      normalise: 'crlf_to_lf',
      note: 'signed with LF, displayed with CRLF: valid after normalisation',
    },
  ];
  crypto.zeroise(key);
  for (const v of vectors) {
    const text = v.normalise ? v.message.replaceAll('\r\n', '\n') : v.message;
    if (crypto.verifyBip137(v.address, text, v.signature) !== v.expected)
      throw new Error(`vector ${v.id} self-check failed`);
  }
  return { _synthetic: SYNTHETIC_MARK, scheme: 'bip137', vectors };
}

export function createWorld(now: Date): World {
  const seed = crypto.randomHex(32);
  const key = crypto.newKeyPair();
  const btc1 = crypto.p2wpkhAddress(key.publicKey33);
  const message = signedMessageFor(btc1);
  const signature = crypto.signBip137(key.secretKey, message, 'p2wpkh');
  crypto.zeroise(key);
  if (crypto.verifyBip137(btc1, message, signature) !== 'valid') throw new Error('SIG-1 self-check failed');

  let btcHg = crypto.randomP2wpkhAddress();
  while (!btcHg.slice(3).includes('a')) btcHg = crypto.randomP2wpkhAddress();

  const addresses: Record<string, ManifestAddress> = {
    'BTC-1': { chain: 'bitcoin', address: btc1, format: 'p2wpkh', role: 'persona_declared' },
    'BTC-2': { chain: 'bitcoin', address: crypto.randomP2wpkhAddress(), format: 'p2wpkh', role: 'persona_declared_v2' },
    'BTC-HG': { chain: 'bitcoin', address: btcHg, format: 'p2wpkh', role: 'homoglyph_source' },
    'BTC-CANARY': {
      chain: 'bitcoin',
      address: crypto.randomP2wpkhAddress(),
      format: 'p2wpkh',
      role: 'robots_canary',
      note: 'only on the robots-disallowed page',
    },
    'ETH-1': { chain: 'evm:1', address: crypto.randomEvmAddress(), format: 'eip55', role: 'exchange_deposit' },
    'ETH-2': { chain: 'evm:1', address: crypto.randomEvmAddress(), format: 'eip55', role: 'unrelated_same_nick' },
    'HOT-1': { chain: 'evm:1', address: crypto.randomEvmAddress(), format: 'eip55', role: 'exchange_hot_wallet' },
    'CONTRACT-1': { chain: 'evm:1', address: crypto.randomEvmAddress(), format: 'eip55', role: 'smart_contract' },
    'TRON-1': { chain: 'tron', address: crypto.randomTronAddress(), format: 'tron_base58', role: 'persona_declared' },
    'TRON-2': {
      chain: 'tron',
      address: crypto.randomTronAddress(),
      format: 'tron_base58',
      role: 'third_party_attribution',
    },
    'TX-DECOY': { chain: 'evm:1', address: `0x${crypto.randomHex(32)}`, format: 'tx_hash', role: 'decoy' },
    D2: { chain: 'bitcoin', address: BIP173_VECTOR, format: 'bip173_vector', role: 'documentation_example' },
    D3: {
      chain: 'bitcoin',
      address: homoglyphOf(btcHg),
      format: 'bech32_homoglyph',
      role: 'decoy',
      foldsTo: 'BTC-HG',
      note: 'first "a" of BTC-HG replaced by Cyrillic U+0430',
    },
  };
  for (let i = 1; i <= 54; i += 1) {
    addresses[`LISTING-${String(i).padStart(2, '0')}`] = {
      chain: 'evm:1',
      address: crypto.randomEvmAddress(),
      format: 'eip55',
      role: 'exchange_listing',
    };
  }
  for (const [slot, { chain, role }] of Object.entries(STORY_SLOTS)) {
    const address =
      chain === 'bitcoin'
        ? crypto.randomP2wpkhAddress()
        : chain === 'tron'
          ? crypto.randomTronAddress()
          : crypto.randomEvmAddress();
    addresses[slot] = {
      chain: chain as ManifestAddress['chain'],
      address,
      format: chain === 'tron' ? 'tron_base58' : chain === 'bitcoin' ? 'p2wpkh' : 'eip55',
      role,
    };
  }
  const values = Object.values(addresses).map((a) => a.address.toLowerCase());
  if (new Set(values).size !== values.length) throw new Error('address collision; run the generator again');

  const listing = Array.from({ length: 55 }, (_unused, index) => {
    const line = index + 1;
    if (line === 24) {
      return {
        line,
        slot: 'HOT-1',
        text: `Giełda Testowa (SYNTHETIC) — portfel gorący: ${addresses['HOT-1']?.address}`,
      };
    }
    const n = String(line < 24 ? line : line - 1).padStart(2, '0');
    return {
      line,
      slot: `LISTING-${n}`,
      text: `Giełda Testowa ${n} (SYNTHETIC) — portfel: ${addresses[`LISTING-${n}`]?.address}`,
    };
  });

  return {
    manifest: {
      schema: 'olcys.persona-fixtures.v1',
      synthetic: true,
      seed,
      generatedAt: now.toISOString(),
      persona: { ...PERSONA },
      syntheticIdentifiers: SYNTHETIC_IDENTIFIERS,
      hostPrefixes: HOST_PREFIXES,
      addresses,
      listing,
      signedMessages: [
        {
          id: 'SIG-1',
          slot: 'BTC-1',
          address: btc1,
          message,
          signature,
          header: Buffer.from(signature, 'base64')[0] ?? 0,
          scheme: 'bip137:p2wpkh',
          locator: 'bitcointalk:msg=65000001',
        },
      ],
      decoys: [
        {
          id: 'D1',
          slot: 'TX-DECOY',
          kind: 'transaction_hash',
          locator: 'bitcointalk:msg=65000101',
          expected: 'not an address candidate',
        },
        {
          id: 'D2',
          slot: 'D2',
          kind: 'documentation_vector',
          locator: 'bitcointalk:msg=65000103',
          expected: 'rejected by A8',
        },
        {
          id: 'D3',
          slot: 'D3',
          kind: 'homoglyph',
          locator: 'telegram:olcys_test_ostrzezenia/102',
          expected: 'no ownership claim; homoglyph detected (folds to BTC-HG)',
        },
        {
          id: 'D4',
          slot: 'HOT-1',
          kind: 'exchange_listing',
          locator: 'bitcointalk:msg=65000102',
          expected: 'HOT-1 rejected by A1; listing attributed to test_moderator, not the persona',
        },
        {
          id: 'D5',
          slot: 'CONTRACT-1',
          kind: 'smart_contract',
          locator: 'bitcointalk:msg=65000104',
          expected: 'rejected by A2',
        },
      ],
      pages: PAGES,
      accounts: ACCOUNTS,
      expected: EXPECTED,
      chain: {
        now: DEMO_NOW,
        usdtContract: USDT_TRC20,
        contractCode: {
          'CONTRACT-1': `0x608060405234801561001057600080fd5b50${derive(seed, 'contract-code:CONTRACT-1')}`,
        },
      },
    },
    testVectors: makeTestVectors(),
  };
}

// --- rendering inputs ------------------------------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const addressOf = (manifest: World['manifest'], slot: string): string => {
  const entry = manifest.addresses[slot];
  if (!entry) throw new Error(`unknown slot ${slot}`);
  return entry.address;
};

export function tokensFor(manifest: World['manifest'], variant: Variant | 'shared'): Record<string, string> {
  const sig = manifest.signedMessages[0];
  if (!sig) throw new Error('manifest has no signed message');
  const tokens: Record<string, string> = {
    BTC_1: addressOf(manifest, 'BTC-1'),
    BTC_2: addressOf(manifest, 'BTC-2'),
    BTC_CANARY: addressOf(manifest, 'BTC-CANARY'),
    ETH_1: addressOf(manifest, 'ETH-1'),
    ETH_2: addressOf(manifest, 'ETH-2'),
    TRON_1: addressOf(manifest, 'TRON-1'),
    TRON_2: addressOf(manifest, 'TRON-2'),
    TX_DECOY: addressOf(manifest, 'TX-DECOY'),
    CONTRACT_1: addressOf(manifest, 'CONTRACT-1'),
    D2: addressOf(manifest, 'D2'),
    D3: addressOf(manifest, 'D3'),
    SIG_1: sig.signature,
    SIGNED_MESSAGE: sig.message,
    LISTING_HTML: manifest.listing.map((l) => escapeHtml(l.text)).join('<br />'),
  };
  if (variant !== 'shared') {
    tokens['PROFILE_BTC'] = addressOf(manifest, variant === 'v1' ? 'BTC-1' : 'BTC-2');
    tokens['LAST_ACTIVE'] = LAST_ACTIVE[variant];
  }
  return tokens;
}

const CEIDG = '/registries/ceidg/v3';
const CEIDG_FIRM_ID = '00000000-0000-4000-8000-000000000001';

/** Polish public registries (CEIDG v3, VAT white list, KRS) in their documented response shapes; synthetic data. */
const REGISTRY_ROUTES: FixtureRouteOut[] = [
  {
    path: `${CEIDG}/firmy`,
    params: { 'imie[]': 'Kacper', 'nazwisko[]': 'Fikcyjny' },
    file: 'registries/ceidg/v3/firmy.json',
  },
  { path: `${CEIDG}/firmy`, params: { 'nip[]': '0001234562' }, file: 'registries/ceidg/v3/firmy.json' },
  // CEIDG answers 204 when nothing matches.
  { path: `${CEIDG}/firmy`, status: 204 },
  { path: `${CEIDG}/firma/${CEIDG_FIRM_ID}`, file: 'registries/ceidg/v3/firma.json' },
  {
    path: '/registries/vat-whitelist/api/search/nip/0001234562',
    file: 'registries/vat-whitelist/api/search/nip/0001234562.json',
  },
  // The persona has no company: the KRS number is unassigned in both registers.
  { path: '/registries/krs/api/OdpisAktualny/0009999901', status: 404, file: 'registries/krs/not-found.json' },
];

export function routesFor(chainRoutes: readonly FixtureRouteOut[]): FixtureRouteOut[] {
  const topic = (t: string, msgs: string[]) =>
    [`${t}.0`, ...msgs.map((m) => `${t}.msg${m}`)].map((query) => ({
      path: BT,
      query: `topic=${query}`,
      file: `bitcointalk/topic-${t}.html`,
    }));
  return [
    { path: BT, query: 'action=profile;u=900001', file: 'bitcointalk/profile-900001.html' },
    { path: BT, query: 'action=profile;user=fikcyjny_kacper', file: 'bitcointalk/profile-900001.html' },
    { path: BT, query: 'action=profile;u=900001;sa=showPosts', file: 'bitcointalk/showposts-900001.html' },
    { path: BT, query: 'action=profile;u=900002', file: 'bitcointalk/profile-900002.html' },
    { path: BT, query: 'action=profile;u=900003', file: 'bitcointalk/profile-900003.html' },
    ...topic('5500001', ['65000001', '65000002']),
    ...topic('5500002', ['65000101', '65000102', '65000103', '65000104']),
    // SMF answers unknown members with an error page and HTTP 200.
    { path: BT, queryPrefix: 'action=profile;', file: 'bitcointalk/error-no-member.html' },
    { path: '/barriers/captcha', file: 'barriers/captcha.html' },
    { path: '/barriers/login', file: 'barriers/login.html' },
    { path: '/barriers/forbidden', status: 403, file: 'barriers/forbidden.html' },
    {
      path: '/barriers/rate-limited',
      status: 429,
      headers: { 'retry-after': '1' },
      file: 'barriers/rate-limited.html',
    },
    {
      path: '/barriers/challenge',
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
      file: 'barriers/challenge.html',
    },
    ...REGISTRY_ROUTES,
    { path: '/barriers/redirect-private', status: 302, headers: { location: '/private/' } },
    { path: '/barriers/redirect-external', status: 302, headers: { location: 'https://example.org/' } },
    ...chainRoutes,
  ];
}

export function chainFor(manifest: World['manifest']): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const slots = Object.fromEntries(Object.entries(manifest.addresses).map(([slot, a]) => [slot, a.address]));
  const of = (chain: string, formats: string[]) =>
    Object.entries(manifest.addresses)
      // Listing addresses use the Etherscan fallbacks; the robots canary must appear on the disallowed page only.
      .filter(
        ([, a]) =>
          a.chain === chain &&
          formats.includes(a.format) &&
          !['exchange_listing', 'robots_canary', 'external_source'].includes(a.role),
      )
      .map(([slot]) => slot)
      .filter((slot) => slot !== 'D2');
  return renderChain(
    manifest.seed,
    slots,
    { btc: of('bitcoin', ['p2wpkh']), evm: of('evm:1', ['eip55']), tron: of('tron', ['tron_base58']) },
    manifest.chain.contractCode,
  );
}

/** Demo label dataset (AddressLabel without import-time `id` and `retrievedAt`). */
export function labelsFor(manifest: World['manifest']): unknown {
  const provenance = {
    datasetId: 'demo-curated',
    url: 'fixtures/labels/demo-curated.json',
    license: 'CC0-1.0',
    lastmod: manifest.generatedAt,
  };
  const exchange = {
    entity: 'Giełda Testowa (SYNTHETIC)',
    category: 'exchange',
    attributes: { custodial: true, fiatCapable: true, plRegistered: true, kyc: true },
    confidence: 95,
  };
  return {
    _synthetic: SYNTHETIC_MARK,
    dataset: { ...provenance, note: 'Synthetic labels for the demo persona; regenerated with the fixture site.' },
    labels: [
      { address: { chain: 'evm:1', address: addressOf(manifest, 'HOT-1') }, ...exchange, provenance },
      { address: { chain: 'tron', address: addressOf(manifest, 'TRON-HOT') }, ...exchange, provenance },
      {
        address: { chain: 'tron', address: addressOf(manifest, 'TRON-DEX') },
        entity: 'DEX Testowy — pula USDT/TRX (SYNTHETIC)',
        category: 'defi_dex',
        attributes: {},
        confidence: 90,
        provenance,
      },
    ],
  };
}
