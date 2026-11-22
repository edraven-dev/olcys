import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPropertyTimelines,
  latestExtractions,
  normalisePageUrl,
  snapshotTimestampToIso,
  type ArchiveSnapshotEntry,
  type TimelineInput,
} from '../src/index.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/timeline/profile-history.json'), 'utf8'));
const PAGE: string = fixture.page;
type Candidate = { captureId: string; address: { chain: string; address: string } };
/** The fixture with a completed extraction for every capture, made from `candidates` (a capture without one is empty). */
const input = (patch: Partial<TimelineInput> & { candidates?: Candidate[] } = {}): TimelineInput => {
  const { candidates = fixture.candidates as Candidate[], ...rest } = patch;
  const merged = { ...structuredClone(fixture), ...rest };
  return {
    ...merged,
    extractions:
      rest.extractions ??
      merged.captures.map((c: { id: string }) => ({
        captureId: c.id,
        candidates: candidates.filter((x) => x.captureId === c.id),
      })),
  };
};
const BTC = (n: number) => `bitcoin:BTC-${n}`;
const pageOnly = (i: TimelineInput) => buildPropertyTimelines(i, { property: 'page.address' });

describe('buildPropertyTimelines', () => {
  it('AC1: one page timeline with three intervals and two bracketed wallet changes', () => {
    const timelines = pageOnly(input());
    expect(timelines).toHaveLength(1);
    const [t] = timelines;
    expect(t!.key).toEqual({ platform: 'web', locator: `web:${PAGE}#page.address`, property: 'page.address' });
    expect(t!.intervals.map((i) => i.values)).toEqual([[BTC(0)], [BTC(1)], [BTC(2)]]);
    expect(t!.changes).toHaveLength(2);
    const [first, second] = t!.changes;
    expect(first).toMatchObject({ before: [BTC(0)], after: [BTC(1)], wallet: true });
    expect(first!.lastSeenBefore).toMatchObject({
      observedAt: '2025-09-15T08:30:00.000Z',
      provenance: 'archive',
      archive: { inferredFromDigest: true },
    });
    expect(first!.firstSeenAfter).toMatchObject({
      observedAt: '2026-02-10T10:15:00.000Z',
      archive: { inferredFromDigest: false, collectedAt: '2026-03-01T09:00:02.000Z' },
    });
    expect(second).toMatchObject({ before: [BTC(1)], after: [BTC(2)], wallet: true });
    expect([second!.lastSeenBefore.captureId, second!.firstSeenAfter.captureId]).toEqual(['l1', 'l2']);
    expect([second!.lastSeenBefore.provenance, second!.firstSeenAfter.provenance]).toEqual(['live', 'live']);
  });

  it('AC2: snapshot timestamps convert to UTC ISO; invalid ones are skipped with a warning', () => {
    expect(snapshotTimestampToIso('20250915083000')).toBe('2025-09-15T08:30:00.000Z');
    expect(snapshotTimestampToIso('2025091508')).toBeUndefined();
    expect(snapshotTimestampToIso('20251345000000')).toBeUndefined();
    const bad: ArchiveSnapshotEntry[] = [
      ...fixture.archive,
      {
        originalUrl: PAGE,
        snapshotTimestamp: '2025091508',
        at: 'x',
        digest: 'D',
        fetched: false,
        digestCheck: 'not_checked',
      },
      {
        originalUrl: PAGE,
        snapshotTimestamp: '20251345000000',
        at: 'x',
        digest: 'D',
        fetched: false,
        digestCheck: 'not_checked',
      },
    ];
    const warnings: string[] = [];
    const [t] = buildPropertyTimelines(
      input({ archive: bad }),
      { property: 'page.address' },
      { warn: (m) => warnings.push(m) },
    );
    expect(warnings).toHaveLength(2);
    expect(t!.points.filter((p) => p.provenance === 'archive')).toHaveLength(3);
  });

  it('AC3: not fetched, digest mismatch and unreadable captures are gaps that change nothing', () => {
    const archive: ArchiveSnapshotEntry[] = [
      ...fixture.archive,
      {
        originalUrl: PAGE,
        snapshotTimestamp: '20251101000000',
        at: '',
        digest: 'DIGEST-NEW',
        fetched: false,
        digestCheck: 'not_checked',
      },
      {
        originalUrl: PAGE,
        snapshotTimestamp: '20251201000000',
        at: '',
        digest: 'DIGEST-M',
        fetched: true,
        captureId: 'am',
        digestCheck: 'mismatch',
      },
      {
        originalUrl: PAGE,
        snapshotTimestamp: '20251215000000',
        at: '',
        digest: 'DIGEST-404',
        fetched: true,
        captureId: 'a404',
        digestCheck: 'match',
      },
    ];
    const mk = (id: string, ts: string, status: 'ok' | 'not_found') => ({
      id,
      runId: 'run-1',
      url: `https://web.archive.org/web/${ts}id_/${PAGE}`,
      status,
      collectedAt: '2026-03-01T09:00:03.000Z',
      archive: { provider: 'wayback', snapshotTimestamp: ts, originalUrl: PAGE },
    });
    const captures = [...fixture.captures, mk('am', '20251201000000', 'ok'), mk('a404', '20251215000000', 'not_found')];
    const candidates = [...fixture.candidates, { captureId: 'am', address: { chain: 'bitcoin', address: 'BTC-9' } }];
    const [t] = pageOnly(input({ archive, captures, candidates }));
    const gaps = t!.points.filter((p) => p.values === null);
    expect(gaps.map((p) => p.gapReason)).toEqual(['not_fetched', 'digest_mismatch', 'not_found']);
    expect(t!.intervals.map((i) => i.values)).toEqual([[BTC(0)], [BTC(1)], [BTC(2)]]);
    expect(t!.changes).toHaveLength(2);
  });

  it('AC3: an unreadable live capture is a gap, never a removal', () => {
    const captures = fixture.captures.map((c: { id: string }) => (c.id === 'l2' ? { ...c, status: 'login_wall' } : c));
    const [t] = pageOnly(input({ captures }));
    expect(t!.points.at(-1)).toMatchObject({ values: null, gapReason: 'login_wall', provenance: 'live' });
    expect(t!.changes).toHaveLength(1);
  });

  it('AC4: a fetched snapshot without candidates is an empty set and a change to []', () => {
    const [t] = pageOnly(
      input({
        candidates: fixture.candidates.filter(
          (c: { captureId: string }) => c.captureId !== 'a3' && c.captureId !== 'l1' && c.captureId !== 'l2',
        ),
        observations: [],
      }),
    );
    expect(t!.points.at(-1)!.values).toEqual([]);
    expect(t!.changes).toEqual([expect.objectContaining({ before: [BTC(0)], after: [] })]);
    const withBtc1 = pageOnly(
      input({ candidates: fixture.candidates.filter((c: { captureId: string }) => c.captureId !== 'a3') }),
    )[0]!;
    expect(withBtc1.changes[0]).toMatchObject({ before: [BTC(0)], after: [] });
    expect(withBtc1.changes[1]).toMatchObject({ before: [], after: [BTC(1)] });
  });

  it('AC5: URL spellings normalise to one key; live and archive points merge', () => {
    expect(normalisePageUrl('http://Forum.Example.org:80/profile/900001/')).toBe(
      normalisePageUrl('https://forum.example.org/profile/900001#x'),
    );
    expect(normalisePageUrl('https://forum.example.org/p?a=1')).toBe('https://forum.example.org/p?a=1');
    const captures = fixture.captures.map((c: { id: string; url: string }) =>
      c.id === 'l1' ? { ...c, url: 'http://Forum.Example.org:80/profile/900001/' } : c,
    );
    const archive = fixture.archive.map((e: { snapshotTimestamp: string }, i: number) =>
      i === 0 ? { ...e, originalUrl: 'https://forum.example.org/profile/900001#x' } : e,
    );
    const timelines = pageOnly(input({ captures, archive }));
    expect(timelines).toHaveLength(1);
    expect(timelines[0]!.points.map((p) => p.provenance)).toEqual(['archive', 'archive', 'archive', 'live', 'live']);
    expect(buildPropertyTimelines(input(), { url: 'http://FORUM.example.org/profile/900001/' })).toHaveLength(3);
    expect(buildPropertyTimelines(input(), { url: 'https://other.example.org/' })).toEqual([]);
  });

  it('AC5: the page a live capture stands for is its logical URL (offline fixture site)', () => {
    const captures = fixture.captures.map((c: { id: string }) =>
      c.id.startsWith('l')
        ? { ...c, url: 'http://127.0.0.1:4100/forum/profile/900001', technical: { logicalUrl: PAGE } }
        : c,
    );
    expect(pageOnly(input({ captures }))[0]!.points.filter((p) => p.provenance === 'live')).toHaveLength(2);
  });

  it('AC5: a capture an account was discovered from stands for the account profile page', () => {
    // The live profile was requested under another URL (by nickname) than the canonical page the archive lists.
    const captures = fixture.captures.map((c: { id: string }) =>
      c.id.startsWith('l') ? { ...c, url: 'https://forum.example.org/profile?user=fikcyjny_kacper' } : c,
    );
    expect(pageOnly(input({ captures }))[0]!.points.filter((p) => p.provenance === 'live')).toEqual([]);
    const accounts = ['l1', 'l2'].map((profileCaptureId) => ({
      profileUrl: PAGE,
      profileCaptureId,
    })) as TimelineInput['accounts'];
    const [t] = pageOnly(input({ captures, accounts }));
    expect(t!.points.map((p) => p.provenance)).toEqual(['archive', 'archive', 'archive', 'live', 'live']);
    expect(t!.changes).toHaveLength(2);
    expect(t!.changes[1]).toMatchObject({ lastSeenBefore: { captureId: 'l1' }, firstSeenAfter: { captureId: 'l2' } });
  });

  it('a page that only linked to the account is not the profile: its capture stays on its own page', () => {
    const search = {
      id: 's1',
      runId: 'run-1',
      url: 'https://forum.example.org/search?q=x',
      status: 'ok',
      collectedAt: '2026-03-01T09:00:05.000Z',
    };
    const captures = [...fixture.captures, search];
    const candidates = [...fixture.candidates, { captureId: 's1', address: { chain: 'bitcoin', address: 'BTC-7' } }];
    // The account was discovered on the search page (`discoveredVia`), but its profile was read by l1 and l2.
    const accounts = [
      { profileUrl: PAGE, profileCaptureId: 'l1', discoveredVia: { captureId: 's1' } },
      { profileUrl: PAGE, profileCaptureId: 'l2', discoveredVia: { captureId: 's1' } },
    ] as unknown as TimelineInput['accounts'];
    const [t] = pageOnly(input({ captures, candidates, accounts }));
    expect(t!.points.map((p) => p.captureId).filter((id) => id === 's1')).toEqual([]);
    expect(t!.intervals.flatMap((i) => i.values)).not.toContain(BTC(7));
  });

  it('a capture without an extraction result is a gap (not a removal); an empty result is an empty page', () => {
    const base = input();
    const extractions = base.extractions.filter((e) => e.captureId !== 'l2');
    const [t] = pageOnly({ ...base, extractions });
    expect(t!.points.at(-1)).toMatchObject({ values: null, gapReason: 'extraction_pending', provenance: 'live' });
    expect(t!.changes).toHaveLength(1);
    const archivedPending = pageOnly({
      ...base,
      extractions: base.extractions.filter((e) => e.captureId !== 'a3'),
    })[0]!;
    expect(archivedPending.points.find((p) => p.captureId === 'a3')).toMatchObject({
      values: null,
      gapReason: 'extraction_pending',
    });
    expect(archivedPending.changes.every((c) => c.after.length > 0)).toBe(true);
  });

  it('latestExtractions: the newest analysis of a capture replaces the older one', () => {
    const older = [
      { captureId: 'c1', candidates: ['BTC-REJECTED'] },
      { captureId: 'c2', candidates: ['x'] },
    ];
    const newer = [{ captureId: 'c1', candidates: [] as string[] }];
    expect(latestExtractions([older, newer])).toEqual([
      { captureId: 'c1', candidates: [] },
      { captureId: 'c2', candidates: ['x'] },
    ]);
    expect(latestExtractions([newer, older]).find((e) => e.captureId === 'c1')?.candidates).toEqual(['BTC-REJECTED']);
  });

  it('AC6: live property observations form their own timeline; walletOnly drops non-wallet keys', () => {
    const all = buildPropertyTimelines(input());
    const bitcoin = all.find((t) => t.key.property === 'profile.bitcoin_address')!;
    expect(bitcoin.key).toEqual({
      platform: 'forum_example',
      locator: 'forum_example:u=900001#profile.bitcoin_address',
      property: 'profile.bitcoin_address',
    });
    expect(bitcoin.points.every((p) => p.provenance === 'live')).toBe(true);
    expect(bitcoin.changes).toHaveLength(1);
    expect(bitcoin.changes[0]).toMatchObject({ before: ['BTC-1'], after: ['BTC-2'], wallet: true });
    expect(all.some((t) => t.key.property === 'profile.display_name')).toBe(true);
    const wallet = buildPropertyTimelines(input(), { walletOnly: true });
    expect(wallet.map((t) => t.key.property).toSorted()).toEqual(['page.address', 'profile.bitcoin_address']);
  });

  it('AC6: a live capture that read the page without the property is an empty point', () => {
    const observations = fixture.observations.filter((o: { id: string }) => o.id !== 'o2');
    const bitcoin = buildPropertyTimelines(input({ observations }), { property: 'profile.bitcoin_address' })[0]!;
    expect(bitcoin.points.map((p) => p.values)).toEqual([['BTC-1'], []]);
    expect(bitcoin.changes[0]).toMatchObject({ before: ['BTC-1'], after: [] });
  });

  it('AC7: deterministic and independent of input order', () => {
    expect(buildPropertyTimelines(input())).toEqual(buildPropertyTimelines(input()));
    const shuffled = input({ captures: fixture.captures.toReversed(), archive: fixture.archive.toReversed() });
    expect(buildPropertyTimelines(shuffled)).toEqual(buildPropertyTimelines(input()));
  });
});
