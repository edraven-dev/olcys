import type { Capture, Observation } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { diffRuns, type RunSnapshot } from '../src/index.ts';

const PROFILE = 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001';

function obs(runId: string, captureId: string, property: string, value: string, locator: string): Observation {
  return {
    id: `${runId}-${property}-${value}`,
    runId,
    captureId,
    sourceId: 'bitcointalk',
    subject: { type: 'account', key: 'bitcointalk:900001' },
    property,
    value,
    locator,
    observedAt: '2026-11-21T10:00:00.000Z',
  };
}

function capture(id: string, status: Capture['status'], url = PROFILE): RunSnapshot['captures'][number] {
  return { id, url, finalUrl: url, status };
}

function snapshot(runId: string, parts: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId,
    algorithm: { algorithmVersion: 'lr.v1', weightsVersion: 'weights.v1' },
    captures: [],
    observations: [],
    assessments: [],
    ...parts,
  };
}

const link = (score: number) => ({
  id: `l${score}`,
  identityId: 'i1',
  address: { chain: 'bitcoin' as const, address: 'bc1qx' },
  score,
});

const LOC = 'bitcointalk:u=900001#profile.bitcoin_address';

describe('diffRuns', () => {
  it('reports a swapped wallet address as VALUE_CHANGED with both captures', () => {
    const before = snapshot('r1', {
      captures: [capture('c1', 'ok')],
      observations: [obs('r1', 'c1', 'profile.bitcoin_address', 'bc1qold', LOC)],
    });
    const after = snapshot('r2', {
      captures: [capture('c2', 'ok')],
      observations: [obs('r2', 'c2', 'profile.bitcoin_address', 'bc1qnew', LOC)],
    });
    const { events, summary } = diffRuns(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'VALUE_CHANGED',
      key: { platform: 'bitcointalk', locator: LOC, property: 'profile.bitcoin_address' },
      before: 'bc1qold',
      after: 'bc1qnew',
      beforeCaptureId: 'c1',
      afterCaptureId: 'c2',
      wallet: true,
      runId: 'r2',
      previousRunId: 'r1',
    });
    expect(events[0]?.keySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.counts).toEqual({ ADDED: 0, REMOVED: 0, VALUE_CHANGED: 1, SCORE_CHANGED: 0 });
  });

  it('suppresses facts behind a login wall instead of reporting them removed', () => {
    const before = snapshot('r1', {
      captures: [capture('c1', 'ok')],
      observations: [obs('r1', 'c1', 'profile.bitcoin_address', 'bc1qold', LOC)],
    });
    const after = snapshot('r2', { captures: [capture('c2', 'login_wall')] });
    const { events, summary } = diffRuns(before, after);
    expect(events).toEqual([]);
    expect(summary.suppressed).toEqual([
      {
        key: { platform: 'bitcointalk', locator: LOC, property: 'profile.bitcoin_address' },
        reason: 'login_wall',
        lastSeenCaptureId: 'c1',
      },
    ]);
    expect(diffRuns(before, snapshot('r2')).summary.suppressed[0]?.reason).toBe('not_collected');
  });

  it('reports facts gone from a page that loaded as REMOVED, new ones as ADDED', () => {
    const before = snapshot('r1', {
      captures: [capture('c1', 'ok')],
      observations: [obs('r1', 'c1', 'post.body', 'stary wpis', 'bitcointalk:msg=1')],
    });
    const after = snapshot('r2', {
      captures: [capture('c2', 'ok')],
      observations: [obs('r2', 'c2', 'post.body', 'nowy wpis', 'bitcointalk:msg=2')],
    });
    expect(diffRuns(before, after).events.map((e) => [e.kind, e.key.locator, e.wallet])).toEqual([
      ['ADDED', 'bitcointalk:msg=2', false],
      ['REMOVED', 'bitcointalk:msg=1', false],
    ]);
  });

  it('compares multi-valued facts as sets', () => {
    const loc = 'bitcointalk:msg=5#post.address_mention';
    const before = snapshot('r1', {
      captures: [capture('c1', 'ok')],
      observations: [
        obs('r1', 'c1', 'post.address_mention', 'a', loc),
        obs('r1', 'c1', 'post.address_mention', 'b', loc),
      ],
    });
    const after = snapshot('r2', {
      captures: [capture('c2', 'ok')],
      observations: [
        obs('r2', 'c2', 'post.address_mention', 'b', loc),
        obs('r2', 'c2', 'post.address_mention', 'c', loc),
      ],
    });
    expect(diffRuns(before, after).events.map((e) => [e.kind, e.before ?? e.after])).toEqual([
      ['ADDED', 'c'],
      ['REMOVED', 'a'],
    ]);
  });

  it('attributes score changes to data, algorithm or both', () => {
    const before = snapshot('r1', { assessments: [link(50)] });
    const rescored = snapshot('r2', {
      algorithm: { algorithmVersion: 'lr.v1', weightsVersion: 'weights.v2' },
      assessments: [link(62)],
    });
    expect(diffRuns(before, rescored).events[0]).toMatchObject({
      kind: 'SCORE_CHANGED',
      scoreBefore: 50,
      scoreAfter: 62,
      cause: 'algorithm',
    });
    const sameAlgorithm = snapshot('r2', { assessments: [link(62)] });
    expect(diffRuns(before, sameAlgorithm).events[0]?.cause).toBe('data');
    expect(diffRuns(before, snapshot('r2', { assessments: [link(50)] })).events).toEqual([]);
  });
});
