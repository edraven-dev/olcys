import { describe, expect, it } from 'vitest';
import {
  bitcointalkUrl,
  detectAccessBarrier,
  findSignedMessages,
  githubLogin,
  parseBitcointalkPosts,
  parseBitcointalkProfile,
  parseClassifiedAd,
  parseFundingJson,
  parseGithubProfile,
  parseGithubRepository,
  parseHtml,
  parseSmfDate,
  parseTelegramPreview,
  parseWykopProfile,
  selectTopics,
  type FixtureMapping,
} from '../src/index.ts';
import { DEFAULT_HOST_PREFIXES } from '../src/framework/urls.ts';
import { BTC_1, BTC_2, ETH_2, fixtureFile, SIGNATURE } from './helpers.ts';

const FIXTURE: FixtureMapping = { baseUrl: 'http://127.0.0.1:4100', hostPrefixes: DEFAULT_HOST_PREFIXES };
const REF = '2026-11-21T12:00:00.000Z';

describe('bitcointalk parsers', () => {
  it('reads the profile fields of v1 and v2, without volatile fields', async () => {
    const v1 = parseBitcointalkProfile(await fixtureFile('bitcointalk/profile-900001.html', 'v1'));
    expect(v1).toMatchObject({ notFound: false, uid: '900001', name: 'fikcyjny_kacper' });
    expect(v1.fields).toMatchObject({
      bitcoin_address: BTC_1,
      website: 'https://example.org/',
      other_contact_info: 'Matrix: @fikcyjny_kacper:example.org',
      date_registered: 'March 14, 2019, 08:12:45 PM',
      position: 'Newbie',
    });
    expect(v1.fields).not.toHaveProperty('email'); // "hidden"
    expect(v1.fields).not.toHaveProperty('age'); // "N/A"
    expect(Object.keys(v1.fields)).not.toContain('last_active');
    expect(v1.signatureText).toBe('SYNTHETIC — persona testowa');
    const v2 = parseBitcointalkProfile(await fixtureFile('bitcointalk/profile-900001.html', 'v2'));
    expect(v2.fields['bitcoin_address']).toBe(BTC_2);
  });

  it('is order-independent and recognises the HTTP-200 "member does not exist" page', async () => {
    const rows = parseBitcointalkProfile(
      '<table><tr><td><b>Bitcoin address:</b></td><td> bc1qx </td></tr><tr><td><b>Name: </b></td><td>a</td></tr></table>',
    );
    expect(rows.fields).toEqual({ bitcoin_address: 'bc1qx', name: 'a' });
    expect(parseBitcointalkProfile(await fixtureFile('bitcointalk/error-no-member.html')).notFound).toBe(true);
  });

  it('converts SMF dates to UTC', () => {
    expect(parseSmfDate('March 14, 2019, 08:12:45 PM', REF)).toBe('2019-03-14T20:12:45.000Z');
    expect(parseSmfDate(' on: November 07, 2026, 06:20:00 PM', REF)).toBe('2026-11-07T18:20:00.000Z');
    expect(parseSmfDate('November 01, 2026, 12:05:00 AM', REF, 60)).toBe('2026-10-31T23:05:00.000Z');
    expect(parseSmfDate('Today at 10:00:00 AM', REF)).toBe('2026-11-21T10:00:00.000Z');
    expect(parseSmfDate('yesterday', REF)).toBeUndefined();
  });

  it('reads Show Posts with board, date and the signed-message block split into parts', async () => {
    const posts = parseBitcointalkPosts(await fixtureFile('bitcointalk/showposts-900001.html'), 'show_posts', {
      uid: '900001',
      name: 'fikcyjny_kacper',
    });
    expect(posts.map((p) => p.msgId)).toEqual(['65000104', '65000103', '65000101', '65000001']);
    const staking = posts[3];
    expect(staking).toMatchObject({ topicId: '5500001', authorUid: '900001', board: 'Meta' });
    expect(staking?.signedMessages).toEqual([
      {
        index: 0,
        address: BTC_1,
        text: `I am fikcyjny_kacper (uid 900001) and I control ${BTC_1}. Date: 2026-11-01. SYNTHETIC TEST DATA - OLCYS fixture.`,
        signature: SIGNATURE,
        armor: 'electrum',
        inQuote: false,
      },
    ]);
    expect(selectTopics(posts, 3)).toEqual([
      { topicId: '5500001', msgId: '65000001' },
      { topicId: '5500002', msgId: '65000101' },
    ]);
  });

  it('reads topic posts with their authors; quotes are flagged', async () => {
    const posts = parseBitcointalkPosts(await fixtureFile('bitcointalk/topic-5500002.html'), 'topic');
    expect(posts.map((p) => [p.msgId, p.authorUid, p.authorName])).toEqual([
      ['65000101', '900001', 'fikcyjny_kacper'],
      ['65000102', '900003', 'test_moderator'],
      ['65000103', '900001', 'fikcyjny_kacper'],
      ['65000104', '900001', 'fikcyjny_kacper'],
    ]);
    expect(posts[0]?.board).toBe('Polski (SYNTHETIC)');
    const quoted = parseHtml(
      '<div class="post"><div class="quoteheader">Quote from: fikcyjny_kacper on November 01, 2026</div><div class="quote">-----BEGIN BITCOIN SIGNED MESSAGE-----<br />hi<br />-----BEGIN BITCOIN SIGNATURE-----<br />Version: Bitcoin-qt (1.0)<br />Address: 1abc<br /><br />SIG=<br />-----END BITCOIN SIGNATURE-----</div>ok</div>',
    ).querySelector('div.post');
    expect(quoted && findSignedMessages(quoted)).toEqual([
      {
        index: 0,
        address: '1abc',
        text: 'hi',
        signature: 'SIG=',
        armor: 'bitcoin_qt',
        inQuote: true,
        quoteAuthor: 'fikcyjny_kacper',
      },
    ]);
  });

  it('builds only guest URL shapes', () => {
    expect(bitcointalkUrl('profile_by_name', { nick: 'fikcyjny_kacper' })).toBe(
      'https://bitcointalk.org/index.php?action=profile;user=fikcyjny_kacper',
    );
    expect(bitcointalkUrl('topic_msg', { topicId: '5500001', msgId: '65000001' })).toBe(
      'https://bitcointalk.org/index.php?topic=5500001.msg65000001',
    );
    expect(() => bitcointalkUrl('profile_by_name', { nick: 'x;action=logout' })).toThrow(
      'invalid bitcointalk member name',
    );
    expect(() => bitcointalkUrl('profile', { uid: '12a' })).toThrow('invalid bitcointalk uid: 12a');
  });
});

describe('other platform parsers', () => {
  it('social profile: about text, the forum link (logical URL) and the entry', async () => {
    const page = parseWykopProfile(
      await fixtureFile('wykop/ludzie/fikcyjny_kacper/index.html'),
      'http://127.0.0.1:4100/wykop/ludzie/fikcyjny_kacper/',
      FIXTURE,
    );
    expect(page.handle).toBe('fikcyjny_kacper');
    expect(page.links).toEqual(['https://bitcointalk.org/index.php?action=profile;u=900001']);
    expect(page.entries).toEqual([
      {
        id: '71000001',
        publishedAt: '2026-10-12T19:05:00.000Z',
        text: 'Przeszedłem na stablecoiny. mój portfel USDT TRC20: TMVZLbhMuEYfsXYUzwWSarLmLPWJUmVPVk',
      },
    ]);
  });

  it('code hosting: profile, repository file list and FUNDING.json claims', async () => {
    expect(githubLogin('fikcyjny_kacper')).toBe('fikcyjny-kacper');
    expect(githubLogin('-')).toBeUndefined();
    const base = 'http://127.0.0.1:4100/github/fikcyjny-kacper/';
    const profile = parseGithubProfile(await fixtureFile('github/fikcyjny-kacper/index.html'), base, FIXTURE);
    expect(profile).toEqual({
      login: 'fikcyjny-kacper',
      repositories: [{ name: 'gas-tracker-cli', url: 'https://github.com/fikcyjny-kacper/gas-tracker-cli' }],
    });
    const repo = parseGithubRepository(
      await fixtureFile('github/fikcyjny-kacper/gas-tracker-cli/index.html'),
      `${base}gas-tracker-cli/`,
      { owner: 'fikcyjny-kacper', name: 'gas-tracker-cli' },
      FIXTURE,
    );
    expect(repo.fundingUrl).toBe('https://raw.githubusercontent.com/fikcyjny-kacper/gas-tracker-cli/HEAD/FUNDING.json');
    const funding = await fixtureFile('github-raw/fikcyjny-kacper/gas-tracker-cli/HEAD/FUNDING.json');
    expect(parseFundingJson(funding)).toEqual([{ chain: 'ethereum', address: ETH_2 }]);
    expect(parseFundingJson('not json')).toEqual([]);
  });

  it('P2P ad: seller name, login, e-mail and the ad', async () => {
    expect(parseClassifiedAd(await fixtureFile('tablica/ogloszenie/81000001/index.html'))).toMatchObject({
      adId: '81000001',
      title: 'Sprzedam USDT (TRC20) za PLN — szybko, BLIK/przelew',
      publishedAt: '2026-10-10T08:30:00.000Z',
      seller: {
        name: 'Kacper Fikcyjny',
        login: 'fikcyjny_kacper',
        email: 'kacper.fikcyjny@example.org',
        since: '2024-02-03',
      },
    });
  });

  it('channel preview: channel info and posts with their author', async () => {
    const preview = parseTelegramPreview(await fixtureFile('telegram/s/olcys_test_ostrzezenia/index.html'));
    expect(preview.isPreview).toBe(true);
    expect(preview.channel).toEqual({
      username: 'olcys_test_ostrzezenia',
      title: 'Alerty Krypto (SYNTHETIC)',
      description: 'Ostrzeżenia przed oszustwami (kanał syntetyczny).',
    });
    expect(preview.posts.map((p) => [p.dataPost, p.publishedAt, p.authorName])).toEqual([
      ['olcys_test_ostrzezenia/101', '2026-11-10T12:00:00.000Z', 'Alerty Krypto (SYNTHETIC)'],
      ['olcys_test_ostrzezenia/102', '2026-11-12T09:30:00.000Z', 'Alerty Krypto (SYNTHETIC)'],
    ]);
    expect(preview.posts[0]?.text).toContain('podpisuje się jako fikcyjny_kacper');
    expect(parseTelegramPreview('<html><body><p>landing</p></body></html>').isPreview).toBe(false);
  });
});

const at = async (file: string, status: number, headers: Record<string, string> = {}, path = '/x') =>
  detectAccessBarrier({ status, headers, finalUrl: `http://127.0.0.1:4100${path}`, html: await fixtureFile(file) });

describe('detectAccessBarrier', () => {
  it('classifies the fixture barrier pages', async () => {
    expect((await at('barriers/captcha.html', 200)).status).toBe('captcha');
    expect((await at('barriers/challenge.html', 403, { 'cf-mitigated': 'challenge' })).signals).toContain(
      'header cf-mitigated: challenge',
    );
    expect((await at('barriers/login.html', 200, {}, '/barriers/login')).status).toBe('login_wall');
    expect((await at('barriers/forbidden.html', 403)).status).toBe('blocked');
    expect(await at('barriers/rate-limited.html', 429, { 'retry-after': '1' })).toEqual({
      status: 'blocked',
      signals: ['HTTP 429 (retry-after: 1)'],
    });
  });

  it('does not flag ordinary pages', async () => {
    expect((await at('bitcointalk/topic-5500001.html', 200)).status).toBe('ok');
    expect(
      (await at('wykop/ludzie/fikcyjny_kacper/index.html', 200, {}, '/wykop/ludzie/fikcyjny_kacper/')).status,
    ).toBe('ok');
  });
});
