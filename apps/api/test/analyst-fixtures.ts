/**
 * SYNTHETIC pipeline for the judgement and override tests: a forum profile (the anchor) with a wallet field and a
 * repaired mention, and a social profile linking to it with an ownership cue — with the real scoring stage.
 * Addresses are synthetic persona addresses; no real person or wallet.
 */
import type {
  AddressCandidate,
  Capture,
  Logger,
  Observation,
  OnlineAccount,
  RoleCue,
  SourceDescriptor,
} from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createScoreStage, type Stage } from '@olcys/worker';

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
export const ANALYST = 'Analityk Testowy';
export const ADDRESS = {
  wallet: 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2',
  repaired: 'bc1qgegxcs9wqknj3cnku7p3gqrkl67pmhljyeg6p3',
} as const;

const FORUM_URL = 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001';
const SOCIAL_URL = 'http://127.0.0.1:4100/wykop/ludzie/fikcyjny_kacper';

export const newCase = {
  title: 'Kacper Fikcyjny (test ocen)',
  purpose: 'Test ocen i korekt analityka na danych syntetycznych',
  legalBasis: 'demonstracja',
  identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
  scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
};

function capture(runId: string, sourceId: string, url: string): Capture {
  return {
    id: newId(),
    runId,
    sourceId,
    url,
    finalUrl: url,
    collectedAt: nowIso(),
    collector: 'test',
    clockSynced: true,
    toolVersion: '0.1.0',
    userAgent: 'test',
    httpStatus: 200,
    status: 'ok',
    artifacts: [],
    manifestSha256: '0'.repeat(64),
    fetchIds: [],
  };
}

function observation(c: Capture, subject: string, property: string, value: string): Observation {
  return {
    id: newId(),
    runId: c.runId,
    captureId: c.id,
    sourceId: c.sourceId,
    subject: { type: 'account', key: subject },
    property,
    value,
    locator: `${subject}#${property}`,
    observedAt: nowIso(),
  };
}

function candidate(
  captureId: string,
  address: string,
  cue: RoleCue,
  extra: Partial<AddressCandidate> = {},
): AddressCandidate {
  return {
    id: newId(),
    captureId,
    raw: address,
    address: { chain: 'bitcoin', address },
    format: 'p2wpkh',
    checksum: { scheme: 'bech32', present: true, valid: true, bits: 30 },
    chainAttribution: { method: 'format_unique' },
    view: 'visible_text',
    span: { start: 0, end: address.length },
    transforms: [],
    context: {
      snippet: '(SYNTHETIC)',
      inCode: false,
      roleCues: [cue],
      pageAddressDensity: 2,
      occurrencesInCapture: 1,
    },
    reviewRequired: false,
    ...extra,
  };
}

/** Stand-in collection: two profile captures, two accounts, a wallet field and a profile link (never in a rescore). */
const collect: Stage = {
  step: 'collect.source',
  async run(ctx) {
    if (ctx.evidenceRunId !== ctx.run.id) return;
    const forum = capture(ctx.run.id, 'bitcointalk', FORUM_URL);
    const social = capture(ctx.run.id, 'wykop', SOCIAL_URL);
    const accounts: OnlineAccount[] = [
      {
        id: newId(),
        runId: ctx.run.id,
        platform: 'bitcointalk',
        handle: 'fikcyjny_kacper',
        platformUserId: '900001',
        profileUrl: FORUM_URL,
        discoveredVia: { sourceId: 'bitcointalk', method: 'input', captureId: forum.id },
      },
      {
        id: newId(),
        runId: ctx.run.id,
        platform: 'wykop',
        handle: 'fikcyjny_kacper',
        profileUrl: SOCIAL_URL,
        discoveredVia: { sourceId: 'wykop', method: 'enumeration', captureId: social.id },
      },
    ];
    await ctx.repos.evidence.addCaptures([forum, social]);
    await ctx.repos.evidence.addAccounts(accounts);
    await ctx.repos.evidence.addObservations([
      observation(forum, 'bitcointalk:900001', 'profile.bitcoin_address', ADDRESS.wallet),
      observation(social, 'wykop:fikcyjny_kacper', 'account.link', FORUM_URL),
    ]);
  },
};

/** Stand-in extraction, run again by a rescore (new candidate ids for the same positions). */
const extract: Stage = {
  step: 'extract.capture',
  async run(ctx) {
    for (const c of await ctx.repos.evidence.listCaptures(ctx.evidenceRunId)) {
      const candidates =
        c.sourceId === 'bitcointalk'
          ? [
              candidate(c.id, ADDRESS.wallet, 'unclear'),
              candidate(c.id, ADDRESS.repaired, 'first_person_owner', {
                reviewRequired: true,
                transforms: ['gap_joined'],
                span: { start: 100, end: 100 + ADDRESS.repaired.length + 2 },
              }),
            ]
          : [candidate(c.id, ADDRESS.wallet, 'first_person_owner')];
      // oxlint-disable-next-line no-await-in-loop
      await ctx.repos.evidence.addExtraction(ctx.run.id, {
        captureId: c.id,
        candidates,
        rejected: [],
        secrets: [],
        extractorVersion: 'test',
      });
    }
  },
};

export const analystStages = (sources: readonly SourceDescriptor[]): Stage[] => [
  collect,
  extract,
  createScoreStage({ sources }),
];
