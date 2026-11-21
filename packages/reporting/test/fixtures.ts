/**
 * SYNTHETIC report data for tests: the fictional persona "Kacper Fikcyjny" with generated addresses. Includes a
 * malicious scraped value and snippet to test escaping. No real person, account or wallet.
 */
import type {
  AddressCandidate,
  AnalysisRun,
  Capture,
  CashOutEvent,
  FeatureContribution,
  HopResult,
  LinkAssessment,
  NormalizedTransfer,
  Observation,
  Valuation,
} from '@olcys/core';
import { REPORT_TEMPLATE_VERSION, type ReportData } from '../src/index.ts';

export const A = {
  BTC1: 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2',
  BTC2: 'bc1qgegxcs9wqknj3cnku7p3gqrkl67pmhljyeg6p3',
  ETH1: '0xcd5c1a91d6dfaafeb0807e3c9d6d00655a54617a',
  ETH2: '0xc3436335b60f0fd74bf6c2638f7a8fa64ac53cd7',
  HOT1: '0x473082f9bd1a611ab783ce9fe814d97b4a8f02b4',
  CONTRACT1: '0x959dc8ea38d76ccdd3765ac138d3167da615fe27',
  FUNDER: '0x1f8e2aab510eaba90b6c9aa44c9109a4c6b56f83',
  TRON1: 'TMVZLbhMuEYfsXYUzwWSarLmLPWJUmVPVk',
  TRON2: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu',
  TRON_BUYER: 'TX212yJwTtj26g1JSVVkP9wC1CHhfF9NeA',
  D2: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  D3: 'bc1qsyrа8u0s8akk2qyh7kkqcfgrexw85n5aqmnhdv',
} as const;

export const MALICIOUS_VALUE = '<img src=x onerror=alert(1)>';
export const MALICIOUS_SNIPPET = 'zobacz </style><script>alert(1)</script> mój portfel';

const RUN = 'run-0002';
const PREV = 'run-0001';
const SHA = (c: string) => c.repeat(64).slice(0, 64);
const FIXTURE = 'http://127.0.0.1:4100';

function capture(id: string, sourceId: string, path: string, at: string, status: Capture['status'] = 'ok'): Capture {
  return {
    id,
    runId: RUN,
    sourceId,
    url: `${FIXTURE}${path}`,
    finalUrl: `${FIXTURE}${path}`,
    collectedAt: at,
    collector: 'analityk-testowy',
    clockSynced: true,
    toolVersion: '0.1.0',
    userAgent: 'OLCyS/0.1.0',
    httpStatus: status === 'ok' ? 200 : 403,
    status,
    artifacts:
      status === 'ok' ? [{ kind: 'html', blob: { sha256: SHA('a1'), bytes: 1024, mediaType: 'text/html' } }] : [],
    manifestSha256: SHA(id.slice(-1)),
    fetchIds: [],
  };
}

function observation(id: string, captureId: string, sourceId: string, property: string, value: string): Observation {
  return {
    id,
    runId: RUN,
    captureId,
    sourceId,
    subject: { type: 'account', key: `${sourceId}:fikcyjny_kacper` },
    property,
    value,
    locator: `${sourceId}:fikcyjny_kacper#${property}`,
    observedAt: '2026-11-21T10:00:00.000Z',
  };
}

function candidate(
  id: string,
  captureId: string,
  chain: LinkAssessment['address']['chain'],
  address: string,
  snippet: string,
): AddressCandidate {
  return {
    id,
    captureId,
    raw: address,
    address: { chain, address },
    format: 'test',
    checksum: { scheme: 'bech32', present: true, valid: true, bits: 30 },
    chainAttribution: { method: 'format_unique' },
    view: 'visible_text',
    span: { start: 0, end: address.length },
    transforms: [],
    context: { snippet, inCode: false, roleCues: [], pageAddressDensity: 1, occurrencesInCapture: 1 },
    reviewRequired: false,
  };
}

function contribution(
  hopName: 'identity' | 'address',
  feature: string,
  bayesFactor: number,
  rho: number,
  evidence: FeatureContribution['evidence'],
  counted = true,
): FeatureContribution {
  const discountedBayesFactor = rho * bayesFactor + (1 - rho);
  return {
    hop: hopName,
    feature,
    reliability: 'B',
    originGroup: `${feature}:group`,
    evidence,
    bayesFactor,
    rho,
    discountedBayesFactor,
    bits: Math.log2(discountedBayesFactor),
    counted,
  };
}

function hop(hopName: 'identity' | 'address', priorBits: number, contributions: FeatureContribution[]): HopResult {
  const totalBits = priorBits + contributions.filter((c) => c.counted).reduce((s, c) => s + c.bits, 0);
  const probability = 2 ** totalBits / (1 + 2 ** totalBits);
  return {
    hop: hopName,
    priorBits,
    contributions,
    totalBits,
    probability,
    likelihoodRatio: 2 ** (totalBits - priorBits),
    enfsiVerbal: 'strong support',
  };
}

function link(
  id: string,
  address: { chain: LinkAssessment['address']['chain']; address: string },
  score: number,
  extra: Partial<LinkAssessment>,
): LinkAssessment {
  return {
    id,
    runId: RUN,
    identityId: 'ident-nick',
    address,
    relation: 'SELF_DECLARED',
    tier: 'E2',
    paths: [],
    probability: score / 100,
    score,
    icd203: 'likely',
    analyticConfidence: 'Moderate',
    gates: [{ gate: 'invalid_checksum', passed: true }],
    algorithmVersion: 'lr.v1',
    weightsVersion: 'weights.v1',
    weightsSha256: SHA('b'),
    rulesVersion: 'exclusion.v1',
    computedAt: '2026-11-21T10:05:00.000Z',
    ...extra,
  };
}

const NBP: Valuation['nbp'] = { table: '224/A/NBP/2026', effectiveDate: '2026-10-13', currency: 'USD', rate: '3.6512' };

function transfer(
  txHash: string,
  at: string,
  from: string,
  to: string,
  amount: string,
  chain: NormalizedTransfer['chain'],
  symbol: string,
): NormalizedTransfer {
  return {
    chain,
    txHash,
    blockHeight: 100,
    blockTime: at,
    from,
    to,
    asset: { chain, symbol, decimals: symbol === 'USDT' ? 6 : 18 },
    amount,
    kind: symbol === 'USDT' ? 'token' : 'native',
    fetchId: `fetch-${txHash}`,
  };
}

export function personaData(): ReportData {
  const run: AnalysisRun = {
    id: RUN,
    caseId: 'case-0001',
    previousRunId: PREV,
    trigger: 'manual',
    mode: 'offline',
    status: 'running',
    config: {
      toolVersion: '0.1.0',
      gitCommit: 'abc1234',
      sourcesConfigSha256: SHA('c'),
      weightsVersion: 'weights.v1',
      weightsSha256: SHA('b'),
      rulesVersions: { exclusion: 'exclusion.v1', cashout: 'cashout.v1' },
    },
    queuedAt: '2026-11-21T10:00:00.000Z',
    startedAt: '2026-11-21T10:00:01.000Z',
  };
  const captures = [
    capture('cap-1', 'bitcointalk', '/bitcointalk/index.php?action=profile;u=900001', '2026-11-21T10:01:00.000Z'),
    capture('cap-2', 'bitcointalk', '/bitcointalk/index.php?topic=65000101', '2026-11-21T10:01:30.000Z'),
    capture('cap-3', 'wykop', '/wykop/ludzie/fikcyjny_kacper', '2026-11-21T10:02:00.000Z'),
    capture('cap-4', 'p2p_ads', '/ogloszenia/usdt-za-pln', '2026-11-21T10:02:30.000Z'),
    capture('cap-5', 'github', '/github/fikcyjny-kacper', '2026-11-21T10:03:00.000Z'),
    capture('cap-6', 'telegram_preview', '/telegram/s/olcys_test_ostrzezenia', '2026-11-21T10:03:30.000Z'),
    capture('cap-7', 'keybase', '/keybase/fikcyjny_kacper/', '2026-11-21T10:04:00.000Z', 'blocked'),
  ];
  const earlier = {
    ...capture('cap-0', 'bitcointalk', '/bitcointalk/index.php?action=profile;u=900001', '2026-11-20T09:00:00.000Z'),
    runId: PREV,
  };

  const btcProfile = observation('obs-1', 'cap-1', 'bitcointalk', 'profile.bitcoin_address', A.BTC1);
  const signed = observation('obs-2', 'cap-2', 'bitcointalk', 'post.signed_message.address', A.BTC1);
  const signedCheck = observation('obs-3', 'cap-2', 'bitcointalk', 'computed.signed_message_check', 'valid');
  const wykopLink = observation(
    'obs-4',
    'cap-3',
    'wykop',
    'account.link',
    `${FIXTURE}/bitcointalk/index.php?action=profile;u=900001`,
  );
  const wykopBio = observation('obs-5', 'cap-3', 'wykop', 'profile.bio', MALICIOUS_VALUE);

  const btcPath = {
    accountId: 'acc-btt',
    identityHop: hop('identity', Math.log2(99), []),
    addressHop: hop('address', -2, [
      contribution('address', 'e1_cryptographic_binding', 1000, 0.95, { observationId: 'obs-2', captureId: 'cap-2' }),
      contribution('address', 'e2_self_assertion', 32, 0.8, { observationId: 'obs-1', captureId: 'cap-1' }),
      contribution('address', 'e2_self_assertion', 32, 0.8, { captureId: 'cap-1' }, false),
    ]),
    probability: 0.9898,
  };
  const tronPath = {
    accountId: 'acc-wykop',
    identityHop: hop('identity', -3.17, [
      contribution('identity', 'profile_link_to_anchor', 32, 0.8, { observationId: 'obs-4', captureId: 'cap-3' }),
      {
        ...contribution('identity', 'exact_username_or_name', 3, 0.95, { observationId: 'obs-5', captureId: 'cap-3' }),
        detail: MALICIOUS_VALUE,
      },
    ]),
    addressHop: hop('address', -2, [
      contribution('address', 'e3_ownership_cue', 8, 0.6, { candidateId: 'cand-tron-wykop', captureId: 'cap-3' }),
      contribution('address', 'second_independent_origin', 8, 0.8, {
        candidateId: 'cand-tron-p2p',
        captureId: 'cap-4',
      }),
    ]),
    probability: 0.66,
  };
  const ethPath = {
    accountId: 'acc-gh',
    identityHop: hop('identity', -3.17, [
      contribution('identity', 'exact_username_or_name', 3, 0.95, { captureId: 'cap-5' }),
    ]),
    addressHop: hop('address', -2, [
      contribution('address', 'e1_cryptographic_binding', 1000, 0.95, { candidateId: 'cand-eth2', captureId: 'cap-5' }),
    ]),
    probability: 0.2427,
  };

  const cashOutB1: CashOutEvent = {
    id: 'co-1',
    runId: RUN,
    address: { chain: 'evm:1', address: A.ETH1 },
    ruleId: 'B1',
    strength: 'strong',
    occurredAt: '2026-10-14T09:30:00.000Z',
    txHashes: ['0xsweep01'],
    amount: '0.0099',
    asset: 'ETH',
    valuation: {
      amount: '0.0099',
      asset: 'ETH',
      at: '2026-10-14T09:30:00.000Z',
      pln: '1520.37',
      method: 'nbp_table_a_previous_business_day',
      nbp: NBP,
    },
    counterparty: {
      address: A.HOT1,
      labelId: 'label-hot1',
      entity: 'Giełda Testowa (SYNTHETIC)',
      category: 'exchange',
    },
    hops: 0,
    explanation: 'transfer to deposit address forwarding to labelled exchange hot wallet',
    rulesVersion: 'cashout.v1',
  };
  const cashOutB5: CashOutEvent = {
    ...cashOutB1,
    id: 'co-2',
    address: { chain: 'tron', address: A.TRON1 },
    ruleId: 'B5',
    strength: 'medium',
    occurredAt: '2026-11-02T12:00:00.000Z',
    txHashes: ['tron-tx-1', 'tron-tx-2'],
    amount: '4800',
    asset: 'USDT',
    valuation: {
      amount: '4800',
      asset: 'USDT',
      at: '2026-11-02T12:00:00.000Z',
      pln: '1234567.5',
      method: 'nbp_table_a_previous_business_day',
      nbp: NBP,
    },
    counterparty: { address: A.TRON_BUYER },
    explanation: 'repeated round-number USDT-TRC20 transfers',
  };

  return {
    reportId: 'report-0001',
    generatedAt: '2026-11-21T13:41:00.000Z',
    templateVersion: REPORT_TEMPLATE_VERSION,
    case: {
      id: 'case-0001',
      title: 'Kacper Fikcyjny (dane syntetyczne)',
      purpose: 'Weryfikacja ujawnionych publicznie adresów kryptowalutowych (scenariusz testowy)',
      legalBasis: 'czynności analityczne KAS — scenariusz demonstracyjny',
      status: 'open',
      scope: {
        enabledSources: ['bitcointalk', 'github', 'wykop'],
        amberJustifications: { bitcointalk: 'Forum wskazane w materiałach sprawy (dane syntetyczne)' },
        chains: ['bitcoin', 'evm:1', 'tron'],
        maxPivotDepth: 2,
      },
      createdAt: '2026-11-21T09:00:00.000Z',
      createdBy: 'analityk-testowy',
      identifiers: [
        {
          id: 'ident-nick',
          caseId: 'case-0001',
          kind: 'nickname',
          value: 'fikcyjny_kacper',
          platform: 'bitcointalk',
          isAnchor: true,
          addedAt: '2026-11-21T09:00:00.000Z',
          addedBy: 'analityk-testowy',
        },
        {
          id: 'ident-mail',
          caseId: 'case-0001',
          kind: 'email',
          value: 'kacper.fikcyjny@example.org',
          isAnchor: false,
          addedAt: '2026-11-21T09:00:00.000Z',
          addedBy: 'analityk-testowy',
        },
      ],
    },
    run,
    previousRun: { ...run, id: PREV, status: 'succeeded', startedAt: '2026-11-20T09:00:00.000Z' },
    weightsStatus: 'uncalibrated',
    sources: [
      {
        id: 'bitcointalk',
        name: 'Bitcointalk (forum)',
        kind: 'forum',
        compliance: 'AMBER',
        reliability: 'B',
        sendsIdentifiersExternally: true,
      },
      {
        id: 'github',
        name: 'GitHub',
        kind: 'code_hosting',
        compliance: 'AMBER',
        reliability: 'B',
        sendsIdentifiersExternally: true,
      },
      {
        id: 'wykop',
        name: 'Wykop',
        kind: 'social',
        compliance: 'GREEN',
        reliability: 'C',
        sendsIdentifiersExternally: true,
      },
      {
        id: 'p2p_ads',
        name: 'Ogłoszenia P2P',
        kind: 'web',
        compliance: 'GREEN',
        reliability: 'C',
        sendsIdentifiersExternally: false,
      },
      {
        id: 'nbp',
        name: 'Kursy walut NBP',
        kind: 'price_fx',
        compliance: 'GREEN',
        reliability: 'A',
        sendsIdentifiersExternally: false,
      },
    ],
    captures,
    earlierCaptures: [earlier],
    accounts: [
      {
        id: 'acc-btt',
        runId: RUN,
        platform: 'bitcointalk',
        handle: 'fikcyjny_kacper',
        platformUserId: '900001',
        profileUrl: `${FIXTURE}/bitcointalk/index.php?action=profile;u=900001`,
        discoveredVia: { sourceId: 'bitcointalk', method: 'input', captureId: 'cap-1' },
      },
      {
        id: 'acc-wykop',
        runId: RUN,
        platform: 'wykop',
        handle: 'fikcyjny_kacper',
        profileUrl: `${FIXTURE}/wykop/ludzie/fikcyjny_kacper`,
        discoveredVia: { sourceId: 'wykop', method: 'enumeration', captureId: 'cap-3' },
      },
      {
        id: 'acc-gh',
        runId: RUN,
        platform: 'github',
        handle: 'fikcyjny-kacper',
        profileUrl: `${FIXTURE}/github/fikcyjny-kacper`,
        discoveredVia: { sourceId: 'github', method: 'enumeration', captureId: 'cap-5' },
      },
    ],
    observations: [btcProfile, signed, signedCheck, wykopLink, wykopBio],
    candidates: [
      candidate('cand-btc-1', 'cap-1', 'bitcoin', A.BTC1, 'Bitcoin address: bc1qqeyy…'),
      candidate('cand-btc-2', 'cap-2', 'bitcoin', A.BTC1, 'Podpisuję wiadomość dla adresu …'),
      candidate('cand-tron-wykop', 'cap-3', 'tron', A.TRON1, MALICIOUS_SNIPPET),
      candidate('cand-tron-p2p', 'cap-4', 'tron', A.TRON1, 'Sprzedam USDT za PLN, wpłaty na TRON'),
      candidate('cand-eth2', 'cap-5', 'evm:1', A.ETH2, 'FUNDING.json: drips ethereum ownedBy'),
      candidate('cand-eth1', 'cap-2', 'evm:1', A.ETH1, 'Wczoraj wpłaciłem na giełdę 0,01 ETH'),
      candidate('cand-tron2', 'cap-6', 'tron', A.TRON2, 'Uwaga! Oszust podaje adres TEF4…'),
      candidate('cand-contract', 'cap-2', 'evm:1', A.CONTRACT1, 'staking kontrakt'),
    ],
    rejectedCandidates: [
      { captureId: 'cap-2', raw: A.D2, reason: 'documentation_example: BIP-173', view: 'code' },
      { captureId: 'cap-2', raw: A.D2, reason: 'documentation_example: BIP-173', view: 'visible_text' },
      { captureId: 'cap-3', raw: A.D3, reason: 'homoglyph_detected', view: 'visible_text' },
      {
        captureId: 'cap-3',
        raw: '0x49032b0b289a725fdf2b0d82ff1384f2366fe4792f18932b55ec828f24014700',
        reason: 'tx_hash_like',
        view: 'visible_text',
      },
      { captureId: 'cap-3', raw: 'xyz123', reason: 'something_new', view: 'visible_text' },
    ],
    secretFindings: 1,
    egress: [
      {
        id: 'eg-1',
        runId: RUN,
        sourceId: 'bitcointalk',
        host: '127.0.0.1',
        method: 'GET',
        urlRedacted: `${FIXTURE}/bitcointalk`,
        purpose: 'profile',
        containsIdentifier: true,
        allowed: true,
        mode: 'offline',
        at: '2026-11-21T10:01:00.000Z',
        httpStatus: 200,
      },
      {
        id: 'eg-2',
        runId: RUN,
        sourceId: 'nbp',
        host: 'api.nbp.pl',
        method: 'GET',
        urlRedacted: 'https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-10-13/',
        purpose: 'fx',
        containsIdentifier: false,
        allowed: true,
        mode: 'offline',
        at: '2026-11-21T10:04:00.000Z',
        httpStatus: 200,
      },
      {
        id: 'eg-3',
        runId: RUN,
        sourceId: 'x_twitter',
        host: 'x.com',
        method: 'GET',
        urlRedacted: 'https://x.com/fikcyjny',
        purpose: 'profile',
        containsIdentifier: true,
        allowed: false,
        denyReason: 'RED',
        mode: 'offline',
        at: '2026-11-21T10:04:10.000Z',
      },
    ],
    transfers: [
      // Deliberately not in chronological order.
      transfer('0xsweep01', '2026-10-14T09:30:00.000Z', A.ETH1, A.HOT1, '0.0099', 'evm:1', 'ETH'),
      transfer('tron-tx-2', '2026-11-03T12:00:00.000Z', A.TRON1, A.TRON_BUYER, '2400', 'tron', 'USDT'),
      transfer('0xfund01', '2026-10-14T08:00:00.000Z', A.FUNDER, A.ETH1, '0.01', 'evm:1', 'ETH'),
      transfer('tron-tx-1', '2026-11-02T12:00:00.000Z', A.TRON1, A.TRON_BUYER, '2400', 'tron', 'USDT'),
      transfer('btc-tx-1', '2026-09-01T07:00:00.000Z', A.FUNDER, A.BTC1, '0.5', 'bitcoin', 'BTC'),
    ],
    flows: [
      {
        from: { chain: 'evm:1', address: A.FUNDER },
        to: { chain: 'evm:1', address: A.ETH1 },
        asset: 'ETH',
        amount: '0.01',
        txHash: '0xfund01',
        at: '2026-10-14T08:00:00.000Z',
        hop: -1,
        valuation: {
          amount: '0.01',
          asset: 'ETH',
          at: '2026-10-14T08:00:00.000Z',
          pln: '1535.73',
          method: 'nbp_table_a_previous_business_day',
          nbp: NBP,
        },
      },
    ],
    links: [
      link('link-eth2', { chain: 'evm:1', address: A.ETH2 }, 24, {
        tier: 'E1',
        icd203: 'unlikely',
        analyticConfidence: 'Low',
        paths: [ethPath],
        probability: 0.2427,
      }),
      link('link-btc1', { chain: 'bitcoin', address: A.BTC1 }, 99, {
        tier: 'E1',
        icd203: 'almost certain',
        analyticConfidence: 'High',
        paths: [btcPath],
        probability: 0.9898,
      }),
      link('link-tron1', { chain: 'tron', address: A.TRON1 }, 66, {
        tier: 'E3',
        icd203: 'likely',
        analyticConfidence: 'Moderate',
        paths: [tronPath],
        probability: 0.66,
      }),
      link('link-eth1', { chain: 'evm:1', address: A.ETH1 }, 0, {
        relation: 'CUSTODIAL_EXCHANGE',
        icd203: 'not assessed',
        probability: 0,
      }),
      link('link-tron2', { chain: 'tron', address: A.TRON2 }, 0, {
        relation: 'THIRD_PARTY_ATTRIBUTION',
        tier: 'E4',
        icd203: 'not assessed',
        probability: 0,
      }),
    ],
    exclusions: [
      {
        id: 'ex-1',
        runId: RUN,
        address: { chain: 'evm:1', address: A.ETH1 },
        ruleId: 'A4',
        outcome: 'reclassified',
        relation: 'CUSTODIAL_EXCHANGE',
        reason: 'forwards to labelled hot wallet',
        evidence: { txHashes: ['0xfund01', '0xsweep01'], kappa: 0.98875, labelIds: ['label-hot1'] },
        rulesVersion: 'exclusion.v1',
      },
      {
        id: 'ex-2',
        runId: RUN,
        address: { chain: 'evm:1', address: A.HOT1 },
        ruleId: 'A1',
        outcome: 'excluded',
        reason: 'labelled exchange hot wallet',
        evidence: { labelIds: ['label-hot1'] },
        rulesVersion: 'exclusion.v1',
      },
      {
        id: 'ex-3',
        runId: RUN,
        address: { chain: 'evm:1', address: A.CONTRACT1 },
        ruleId: 'A2',
        outcome: 'excluded',
        reason: 'eth_getCode returned bytecode',
        evidence: {},
        rulesVersion: 'exclusion.v1',
      },
    ],
    labels: [
      {
        id: 'label-hot1',
        address: { chain: 'evm:1', address: A.HOT1 },
        entity: 'Giełda Testowa (SYNTHETIC)',
        category: 'exchange',
        attributes: { custodial: true, fiatCapable: true },
        provenance: {
          datasetId: 'demo-curated',
          url: 'fixtures/labels/demo-curated.json',
          license: 'CC0-1.0',
          lastmod: '2026-11-21T19:21:30.440Z',
          retrievedAt: '2026-11-21T10:00:00.000Z',
        },
        confidence: 95,
      },
    ],
    activity: [
      {
        address: { chain: 'evm:1', address: A.ETH1 },
        window: {},
        txCount: 2,
        volumeIn: { native: '0.01', pln: '1535.73' },
        volumeOut: { native: '0.0099', pln: '1520.37' },
        counterpartyCount: 2,
        serviceInteractions: [
          { category: 'exchange', entity: 'Giełda Testowa (SYNTHETIC)', direction: 'out', count: 1, pln: '1520.37' },
        ],
        swaps: [],
        cashOut: { events: [cashOutB1], score: 80 },
        computedAt: '2026-11-21T10:05:00.000Z',
        rulesVersion: 'cashout.v1',
      },
      {
        address: { chain: 'tron', address: A.TRON1 },
        window: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' },
        txCount: 2,
        volumeIn: { native: '0' },
        volumeOut: { native: '4800', pln: '17520.00' },
        counterpartyCount: 1,
        serviceInteractions: [],
        swaps: [
          {
            chain: 'tron',
            txHash: 'tron-swap-1',
            at: '2026-11-01T10:00:00.000Z',
            venue: 'DEX Testowy',
            sold: { asset: 'TRX', amount: '1000' },
            bought: { asset: 'USDT', amount: '120' },
            intoStablecoin: true,
          },
        ],
        stablecoinConversionPln: '438.14',
        cashOut: { events: [cashOutB5], score: 50 },
        computedAt: '2026-11-21T10:05:00.000Z',
        rulesVersion: 'cashout.v1',
      },
    ],
    cashOuts: [cashOutB5, cashOutB1],
    changes: [
      {
        id: 'ch-1',
        runId: RUN,
        previousRunId: PREV,
        kind: 'VALUE_CHANGED',
        key: {
          platform: 'bitcointalk',
          locator: 'bitcointalk:u=900001#profile.bitcoin_address',
          property: 'profile.bitcoin_address',
        },
        before: A.BTC2,
        after: A.BTC1,
        beforeCaptureId: 'cap-0',
        afterCaptureId: 'cap-1',
        detectedAt: '2026-11-21T10:06:00.000Z',
      },
      {
        id: 'ch-2',
        runId: RUN,
        previousRunId: PREV,
        kind: 'SCORE_CHANGED',
        key: { identityId: 'ident-nick', platform: 'link', locator: `tron:${A.TRON1}`, property: 'link.score' },
        before: '50',
        after: '66',
        scoreBefore: 50,
        scoreAfter: 66,
        cause: 'data',
        detectedAt: '2026-11-21T10:06:00.000Z',
      },
    ],
  };
}

/** Minimal data: a case with no findings (first run, nothing collected). */
export function emptyData(): ReportData {
  const full = personaData();
  return {
    ...full,
    previousRun: undefined,
    run: { ...full.run, previousRunId: undefined },
    sources: [],
    captures: [],
    earlierCaptures: [],
    accounts: [],
    observations: [],
    candidates: [],
    rejectedCandidates: [],
    secretFindings: 0,
    egress: [],
    transfers: [],
    flows: [],
    links: [],
    exclusions: [],
    labels: [],
    activity: [],
    cashOuts: [],
    changes: [],
  };
}
