/** `buildWaybackHistory` when one snapshot was fetched in several runs: the usable copy speaks for it, in any order. */
import type { Capture, Observation } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildWaybackHistory, waybackLocator } from '../src/wayback/history.ts';

const PAGE = 'https://forum.example.org/profile/900001';
const TS = '20250301120000';
const locator = waybackLocator(PAGE, TS);

const capture = (id: string, status: Capture['status'], collectedAt: string): Capture =>
  ({
    id,
    runId: `run-${id}`,
    status,
    collectedAt,
    archive: { provider: 'wayback', snapshotTimestamp: TS, originalUrl: PAGE },
  }) as Capture;

const observation = (captureId: string, property: string, value: string): Observation =>
  ({
    id: `${captureId}-${property}`,
    runId: `run-${captureId}`,
    captureId,
    sourceId: 'wayback_cdx',
    subject: { type: 'page', key: PAGE },
    property,
    value,
    locator,
    observedAt: '2026-03-01T09:00:00.000Z',
  }) as Observation;

const snapshotRows = [observation('x', 'archive.snapshot', TS), observation('x', 'archive.digest', 'DIGEST-A')];

describe('buildWaybackHistory with repeated fetches of one snapshot', () => {
  const good = capture('good', 'ok', '2026-03-01T09:00:00.000Z');
  const oldFailure = capture('old', 'error', '2026-02-01T09:00:00.000Z');
  const newFailure = capture('new', 'blocked', '2026-04-01T09:00:00.000Z');
  const check = observation('good', 'computed.archive_digest_check', 'match');

  it.each([
    ['newest first', [newFailure, good, oldFailure]],
    ['oldest first', [oldFailure, good, newFailure]],
  ])('a usable capture beats failed ones (%s)', (_order, captures) => {
    const [entry] = buildWaybackHistory(captures, [...snapshotRows, check]);
    expect(entry).toMatchObject({ fetched: true, captureId: 'good', digestCheck: 'match' });
  });

  it('a digest mismatch loses to a matching copy; among equals the newest wins, whatever the order', () => {
    const mismatch = capture('bad', 'ok', '2026-05-01T09:00:00.000Z');
    const badCheck = observation('bad', 'computed.archive_digest_check', 'mismatch');
    for (const captures of [
      [mismatch, good],
      [good, mismatch],
    ]) {
      expect(buildWaybackHistory(captures, [...snapshotRows, check, badCheck])[0]).toMatchObject({
        captureId: 'good',
        digestCheck: 'match',
      });
    }
    const newer = capture('newer', 'ok', '2026-06-01T09:00:00.000Z');
    for (const captures of [
      [good, newer],
      [newer, good],
    ]) {
      expect(buildWaybackHistory(captures, snapshotRows)[0]).toMatchObject({ captureId: 'newer' });
    }
  });

  it('only failures: the newest failure is the entry capture', () => {
    for (const captures of [
      [oldFailure, newFailure],
      [newFailure, oldFailure],
    ]) {
      expect(buildWaybackHistory(captures, snapshotRows)[0]).toMatchObject({ captureId: 'new' });
    }
  });
});
