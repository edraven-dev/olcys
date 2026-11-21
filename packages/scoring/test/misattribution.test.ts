import { addressKey, type LinkAssessment, type Observation, type OnlineAccount } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAccountIndex } from '../src/features/accounts.ts';
import { namesAccount } from '../src/features/address.ts';
import { scoreRun, type FeatureExtractionInput, type ScoringWeights } from '../src/index.ts';
import { clock, idSequence, v2 } from './fixtures/helpers.ts';
import { capture, candidate, MANIFEST, personaInputs, slot } from './fixtures/persona-inputs.ts';

let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const AT = '2026-11-21T10:00:00.000Z';
const page = (key: string) => ({ type: 'page', key }) as const;
const score = (input: FeatureExtractionInput) => scoreRun(input, w, { clock, newId: idSequence() });

function fact(
  id: string,
  captureId: string,
  subject: Observation['subject'],
  property: string,
  value: string,
): Observation {
  return {
    id,
    runId: 'run-persona',
    captureId,
    sourceId: 'fixture_site',
    subject,
    property,
    value,
    locator: `${subject.key}#${property}`,
    observedAt: AT,
  };
}

const keyOf = (slotName: string, chain?: string): string => {
  const ref = slot(slotName);
  const evm = ref.chain.startsWith('evm:');
  return addressKey({ chain: (chain ?? ref.chain) as never, address: evm ? ref.address.toLowerCase() : ref.address });
};

const find = (assessments: LinkAssessment[], slotName: string): LinkAssessment | undefined =>
  assessments.find((a) => addressKey(a.address) === keyOf(slotName));

function extraction(input: FeatureExtractionInput, captureId: string) {
  const found = input.extractions.find((e) => e.captureId === captureId);
  if (found) return found;
  const created = { captureId, candidates: [], rejected: [], secrets: [], extractorVersion: 'test' };
  input.extractions.push(created);
  return created;
}

describe('misattribution guards', () => {
  it('a deposit cue keeps the claim custodial even when the same account lists the address in its profile', () => {
    const input = personaInputs();
    const eth1 = slot('ETH-1');
    input.observations.push(
      fact(
        'obs-eth1-profile',
        'cap-profile',
        { type: 'account', key: 'bitcointalk:900001' },
        'profile.ethereum_address',
        eth1.address,
      ),
    );
    extraction(input, 'cap-profile').candidates.push(
      candidate('cand-profile-eth1', 'cap-profile', 'ETH-1', ['unclear']),
    );
    const link = find(score(input).assessments, 'ETH-1');
    expect([link?.relation, link?.tier, link?.score, link?.band]).toEqual([
      'CUSTODIAL_EXCHANGE',
      'E2',
      0,
      'WYKLUCZENIE',
    ]);
    expect(link?.gates.find((g) => g.gate === 'relation')?.passed).toBe(false);
    expect(link?.ungated?.score).toBe(86);
    // The profile field carries the arithmetic; the superseded deposit mention adds no bits.
    expect(link?.paths[0]?.addressHop.contributions.map((c) => c.feature)).toEqual(['e2_self_assertion']);
  });

  it('a copied signed message binds nobody but the account it names', () => {
    const index = buildAccountIndex(
      [account('acc-persona', 'fikcyjny_kacper', '900001'), account('acc-kacper', 'kacper', '900004')],
      [],
    );
    const persona = index.resolve('bitcointalk:900001');
    const kacper = index.resolve('bitcointalk:900004');
    if (!persona || !kacper) throw new Error('accounts not indexed');
    const message = MANIFEST.signedMessages[0]?.message ?? '';
    expect(namesAccount(message, persona)).toBe(true);
    expect(namesAccount(message, kacper)).toBe(false);
    expect(namesAccount('Jestem fikcyjny_kacper.', persona)).toBe(true);
    expect(namesAccount('profile index.php?action=profile;u=900001', persona)).toBe(true);
    expect(namesAccount('I am fikcyjny_kacper2', persona)).toBe(false);
    expect(namesAccount('I am the owner, fikcyjny_kacper', persona)).toBe(false);
    expect(namesAccount('uid 9000011', persona)).toBe(false);
    expect(namesAccount('Order 900001 shipped', persona)).toBe(false);

    // The persona's valid message re-posted by another account earns that account no cryptographic binding.
    const input = personaInputs();
    const sig = MANIFEST.signedMessages[0];
    if (!sig) throw new Error('manifest without a signed message');
    input.identifiers.push({
      ...input.identifiers[0]!,
      id: 'idf-9',
      value: 'kacper',
      platform: undefined,
      isAnchor: false,
    });
    input.accounts.push(account('acc-kacper', 'kacper', '900004'));
    input.captures.push(capture('cap-copy', 'https://bitcointalk.org/index.php?topic=5500009.0'));
    const by = { type: 'account', key: 'bitcointalk:900004' } as const;
    input.observations.push(
      fact('obs-copy-1', 'cap-copy', by, 'post.signed_message.address', sig.address),
      fact('obs-copy-2', 'cap-copy', by, 'post.signed_message.text', sig.message),
      fact('obs-copy-3', 'cap-copy', by, 'post.signed_message.signature', sig.signature),
    );
    extraction(input, 'cap-copy').candidates.push(
      candidate('cand-copy', 'cap-copy', 'BTC-1', ['unclear'], { inCode: true }),
    );
    const { assessments, notes } = score(input);
    const btc1 = find(assessments, 'BTC-1');
    const copy = btc1?.paths.find((p) => p.originGroup === 'acct:bitcointalk:900004');
    expect(copy?.addressHop.contributions.some((c) => c.feature === 'e1_cryptographic_binding')).toBe(false);
    expect(notes.find((n) => n.code === 'signed_message_unbound')?.captureId).toBe('cap-copy');
    expect(btc1?.score).toBe(99);
  });

  it('post anchors never resolve across platforms, and the capture’s own author comes first', () => {
    const input = personaInputs();
    input.captures.push(
      capture('cap-foreign', 'https://other-forum.example.org/index.php?topic=1'),
      capture('cap-single', 'https://other-forum.example.org/index.php?topic=2'),
    );
    input.observations.push(
      fact('obs-f1', 'cap-foreign', page('otherforum:msg=7'), 'post.author', 'telegram:olcys_test_ostrzezenia'),
      fact('obs-f2', 'cap-foreign', page('otherforum:msg=8'), 'post.author', 'bitcointalk:900003'),
      fact('obs-s1', 'cap-single', page('otherforum:msg=9'), 'post.author', 'bitcointalk:900003'),
    );
    // Same post token as the persona's deposit post (`msg65000101`) on the forum fixture.
    extraction(input, 'cap-foreign').candidates.push(
      candidate('cand-foreign', 'cap-foreign', 'LISTING-03', ['first_person_owner'], { anchor: 'msg65000101' }),
    );
    extraction(input, 'cap-single').candidates.push(
      candidate('cand-single', 'cap-single', 'LISTING-04', ['first_person_owner'], { anchor: 'msg65000101' }),
    );
    const { assessments, notes } = score(input);
    expect(find(assessments, 'LISTING-03')).toBeUndefined();
    expect(find(assessments, 'LISTING-04')).toBeUndefined();
    expect(notes.find((n) => n.code === 'unattributed_mention')?.captureId).toBe('cap-foreign');
    expect(notes.some((n) => n.code === 'no_identity_path' && n.detail.includes(keyOf('LISTING-04')))).toBe(true);
    // Same-platform anchors still resolve: the persona's deposit post keeps its author.
    expect(find(assessments, 'ETH-1')?.relation).toBe('CUSTODIAL_EXCHANGE');
  });

  it('an observed address never borrows the chain of another capture', () => {
    const input = personaInputs();
    extraction(input, 'cap-funding').candidates = [];
    input.captures.push(capture('cap-explorer', 'https://explorer.example.org/address/synthetic'));
    const polygon = candidate('cand-explorer', 'cap-explorer', 'ETH-2', ['unclear']);
    extraction(input, 'cap-explorer').candidates.push({
      ...polygon,
      address: { ...polygon.address, chain: 'evm:137' },
      chainAttribution: { method: 'explorer_domain' },
    });
    const { assessments, notes } = score(input);
    expect(assessments.some((a) => a.address.address === polygon.address.address)).toBe(false);
    expect(notes.find((n) => n.code === 'observation_address_unconfirmed')?.captureId).toBe('cap-funding');

    // A chain that follows from the address format alone may still confirm a fact from another capture.
    const btc = personaInputs();
    extraction(btc, 'cap-profile').candidates = [];
    const btc1 = find(score(btc).assessments, 'BTC-1');
    expect(btc1?.paths[0]?.addressHop.contributions.filter((c) => c.counted).map((c) => c.feature)).toEqual([
      'e1_cryptographic_binding',
      'e2_self_assertion',
    ]);
  });

  it('duplicate discoveries of one account keep every identity clue', () => {
    const input = personaInputs();
    const tablica = input.accounts.find((a) => a.id === 'acc-tablica');
    if (!tablica) throw new Error('fixture without the classified-ad account');
    const { displayName, ...withoutName } = tablica;
    input.accounts = [
      ...input.accounts.filter((a) => a !== tablica),
      { ...withoutName, id: 'acc-tablica-1', handle: 'sprzedawca81', platformUserId: '81000001' },
      { ...tablica, id: 'acc-tablica-2', handle: 'stary_nick', platformUserId: '81000001', displayName },
    ];
    input.observations = input.observations.filter((o) => !o.subject.key.startsWith('tablica:'));

    const index = buildAccountIndex(input.accounts, input.identifiers);
    const merged = index.resolve('tablica:81000001');
    expect(merged?.records.map((r) => r.id)).toEqual(['acc-tablica-1', 'acc-tablica-2']);
    expect(merged?.account.displayName).toBe('Kacper Fikcyjny');
    expect(index.resolve('tablica:stary_nick')).toBe(merged);
    expect(index.byId('acc-tablica-2')).toBe(merged);

    // The display name only the second discovery carries still gives the ad its identity path.
    const tron1 = find(score(input).assessments, 'TRON-1');
    const ad = tron1?.paths.find((p) => p.service === 'tablica');
    expect(ad?.identityHop.contributions.map((c) => [c.feature, c.counted])).toEqual([
      ['exact_username_or_name', true],
    ]);
    expect(tron1?.score).toBe(57);
  });

  it('similar handles are separate accounts: a numeric-id anchor never extends to a look-alike handle', () => {
    const input = personaInputs();
    input.identifiers.push({
      ...input.identifiers[0]!,
      id: 'idf-forum2',
      kind: 'social_login',
      value: '555',
      platform: 'forum2',
    });
    input.accounts.push(
      forum2('acc-f2-a', 'demo-user', { platformUserId: '555' }),
      forum2('acc-f2-b', 'demo_user', {
        discoveredVia: { sourceId: 'fixture_site', method: 'search', captureId: 'cap-f2' },
      }),
    );
    const index = buildAccountIndex(input.accounts, input.identifiers);
    const anchored = index.resolve('forum2:555');
    const lookalike = index.resolve('forum2:demo_user');
    expect(anchored?.anchor).toBe(true);
    expect(lookalike).toBeDefined();
    expect(lookalike).not.toBe(anchored);
    expect(lookalike?.anchor).toBe(false);
    expect(index.resolve('forum2:demo-user')).toBe(anchored);

    input.captures.push(capture('cap-f2', 'https://forum2.example.org/u/demo_user'));
    input.observations.push(
      fact(
        'obs-f2',
        'cap-f2',
        { type: 'account', key: 'forum2:demo_user' },
        'profile.ethereum_address',
        slot('LISTING-05').address,
      ),
    );
    extraction(input, 'cap-f2').candidates.push(candidate('cand-f2', 'cap-f2', 'LISTING-05', ['unclear']));
    const { assessments, notes } = score(input);
    expect(find(assessments, 'LISTING-05')).toBeUndefined();
    expect(notes.some((n) => n.code === 'no_identity_path' && n.detail.includes('forum2:demo_user'))).toBe(true);
    expect(find(assessments, 'BTC-1')?.score).toBe(99);
  });

  it('accented handles keep their signed-message binding (NFC and case only, no accent folding)', () => {
    const index = buildAccountIndex([account('acc-zolw', 'żółw', '900005')], []);
    const zolw = index.resolve('bitcointalk:900005');
    if (!zolw) throw new Error('account not indexed');
    expect(namesAccount('Jestem żółw.', zolw)).toBe(true);
    expect(namesAccount('JESTEM ŻÓŁW', zolw)).toBe(true);
    expect(namesAccount('Jestem żółw.'.normalize('NFD'), zolw)).toBe(true);
    expect(namesAccount('Użytkownik: żółw', zolw)).toBe(true);
    expect(namesAccount('Jestem zolw.', zolw)).toBe(false);
    expect(index.resolve('bitcointalk:ŻÓŁW')).toBe(zolw);
    expect(index.resolve('bitcointalk:zolw')).toBeUndefined();
  });
});

const forum2 = (id: string, handle: string, extra: Partial<OnlineAccount> = {}): OnlineAccount => ({
  id,
  runId: 'run-persona',
  platform: 'forum2',
  handle,
  profileUrl: `https://forum2.example.org/u/${handle}`,
  discoveredVia: { sourceId: 'fixture_site', method: 'cross_link' },
  ...extra,
});

function account(id: string, handle: string, uid: string): OnlineAccount {
  return {
    id,
    runId: 'run-persona',
    platform: 'bitcointalk',
    handle,
    platformUserId: uid,
    profileUrl: `https://bitcointalk.org/index.php?action=profile;u=${uid}`,
    discoveredVia: { sourceId: 'fixture_site', method: 'cross_link' },
  };
}
