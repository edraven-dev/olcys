/** The page timeline panel: intervals with their provenance, bracketed changes, inferred dates and gaps. */
import type { PropertyTimeline, TimelinePoint } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageTimelineView } from '../src/features/changes/PageTimeline.tsx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const archive = (at: string, values: string[] | null, extra: Partial<TimelinePoint> = {}): TimelinePoint => ({
  observedAt: at,
  values,
  provenance: 'archive',
  archive: { snapshotTimestamp: at.replace(/\D/g, '').slice(0, 14), digest: 'D', inferredFromDigest: false },
  ...extra,
});
const live = (at: string, values: string[]): TimelinePoint => ({ observedAt: at, values, provenance: 'live' });

const a0 = archive('2025-03-01T12:00:00.000Z', ['bitcoin:BTC-0']);
const a1 = archive('2025-09-15T08:30:00.000Z', ['bitcoin:BTC-0'], {
  archive: { snapshotTimestamp: '20250915083000', digest: 'D', inferredFromDigest: true },
});
const gap = archive('2025-11-01T00:00:00.000Z', null, { gapReason: 'not_fetched' });
const a2 = archive('2026-02-10T10:15:00.000Z', ['bitcoin:BTC-1']);
const l1 = live('2026-03-01T09:00:10.000Z', ['bitcoin:BTC-1']);

const timeline: PropertyTimeline = {
  key: {
    platform: 'web',
    locator: 'web:https://forum.example.org/profile/900001#page.address',
    property: 'page.address',
  },
  points: [a0, a1, gap, a2, l1],
  intervals: [
    { values: ['bitcoin:BTC-0'], from: a0, to: a1 },
    { values: ['bitcoin:BTC-1'], from: a2, to: l1 },
  ],
  changes: [
    { before: ['bitcoin:BTC-0'], after: ['bitcoin:BTC-1'], lastSeenBefore: a1, firstSeenAfter: a2, wallet: true },
  ],
};

describe('page timeline panel', () => {
  it('shows intervals with provenance, the bracketed wallet change, the inferred date and the gap in Polish', () => {
    const content = text(renderToStaticMarkup(<PageTimelineView timelines={[timeline]} />));
    expect(content).toContain('bitcoin:BTC-0');
    expect(content).toContain('bitcoin:BTC-1');
    expect(content).toContain('kopia archiwalna');
    expect(content).toContain('przebieg');
    expect(content).toContain('zmiana portfela');
    expect(content).toContain('Ostatnio widziane przed zmianą');
    expect(content).toContain('Pierwszy odczyt po zmianie');
    expect(content.match(/data przybliżona \(ten sam skrót\)/g)).toHaveLength(2);
    expect(content).toContain('luka: kopia niepobrana');
    expect(content).toContain('web:https://forum.example.org/profile/900001#page.address');
  });

  it('says when a timeline has no change and when a page held no address', () => {
    const empty: PropertyTimeline = {
      ...timeline,
      intervals: [
        { values: [], from: archive('2024-03-12T10:15:00.000Z', []), to: archive('2024-03-12T10:15:00.000Z', []) },
      ],
      changes: [],
    };
    const content = text(renderToStaticMarkup(<PageTimelineView timelines={[empty]} />));
    expect(content).toContain('brak adresu na stronie');
    expect(content).toContain('Brak zmian wartości');
  });
});
