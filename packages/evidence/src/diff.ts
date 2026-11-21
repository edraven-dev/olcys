/**
 * Run-to-run comparison. Facts are compared by `(platform, locator, property)`; a fact missing from a page that was
 * blocked, hidden behind a login wall or a CAPTCHA, failed or was not collected is suppressed instead of reported as
 * REMOVED. A VALUE_CHANGED on an address-valued property is a wallet swap. Link scores produce SCORE_CHANGED with the
 * cause (data, algorithm or both). Pure: the caller persists the events.
 */
import type { Capture, ChangeEvent, ChangeKind, Id, LinkAssessment, Observation } from '@olcys/core';
import { addressKey, canonicalJson, CHANGE_KINDS, isAddressValuedProperty } from '@olcys/core';
import { sha256Hex } from './blob-store.ts';

export const DIFF_VERSION = 'diff.v1';

export const SUPPRESSION_REASONS = ['blocked', 'login_wall', 'captcha', 'error', 'not_collected'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface RunSnapshot {
  runId: Id;
  /** Versions of the scoring inputs; a difference marks SCORE_CHANGED as caused by the algorithm. */
  algorithm: { algorithmVersion: string; weightsVersion: string };
  captures: Pick<Capture, 'id' | 'url' | 'finalUrl' | 'status'>[];
  observations: Observation[];
  assessments: Pick<LinkAssessment, 'id' | 'identityId' | 'address' | 'relation' | 'score'>[];
}

export type ChangeEventDraft = Omit<ChangeEvent, 'id' | 'detectedAt'> & {
  /** True for a change of an address-valued property (wallet swap alert). */
  wallet: boolean;
  /** sha256(canonicalJson({ kind, key, before, after })) — idempotent persistence key. */
  keySha256: string;
};

export interface RunDiff {
  events: ChangeEventDraft[];
  summary: {
    runId: Id;
    previousRunId: Id;
    diffVersion: string;
    counts: Record<ChangeKind, number>;
    suppressed: { key: ChangeEvent['key']; reason: SuppressionReason; lastSeenCaptureId: Id }[];
  };
}

export const isWalletProperty = isAddressValuedProperty;

type Key = ChangeEvent['key'];

function keyOf(o: Observation): Key {
  return { platform: o.sourceId, locator: o.locator, property: o.property };
}

const keyString = (key: Key): string => canonicalJson(key);

function draftKey(e: Pick<ChangeEventDraft, 'kind' | 'key' | 'before' | 'after'>): string {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson({ kind: e.kind, key: e.key, before: e.before, after: e.after })),
  );
}

function group(observations: readonly Observation[]): Map<string, { key: Key; values: Map<string, Observation> }> {
  const groups = new Map<string, { key: Key; values: Map<string, Observation> }>();
  for (const o of observations) {
    const key = keyOf(o);
    const id = keyString(key);
    const entry = groups.get(id) ?? { key, values: new Map<string, Observation>() };
    entry.values.set(o.value, o);
    groups.set(id, entry);
  }
  return groups;
}

/** Why a fact seen before is absent now, when the absence is not evidence of removal. */
function suppression(previous: Observation, before: RunSnapshot, after: RunSnapshot): SuppressionReason | undefined {
  const page = before.captures.find((c) => c.id === previous.captureId);
  if (!page) return 'not_collected';
  const now = after.captures.find((c) => c.url === page.url || c.finalUrl === page.finalUrl);
  if (!now) return 'not_collected';
  // A page that loaded, or is confirmed gone (not_found), shows real removals.
  if (now.status === 'ok' || now.status === 'not_found') return undefined;
  if (now.status === 'blocked' || now.status === 'login_wall' || now.status === 'captcha') return now.status;
  return 'error';
}

export function diffRuns(before: RunSnapshot, after: RunSnapshot, options: { scoreDeltaMin?: number } = {}): RunDiff {
  const scoreDeltaMin = options.scoreDeltaMin ?? 1;
  const events: ChangeEventDraft[] = [];
  const suppressed: RunDiff['summary']['suppressed'] = [];
  const base = { runId: after.runId, previousRunId: before.runId };
  const push = (draft: Omit<ChangeEventDraft, 'runId' | 'previousRunId' | 'keySha256'>) =>
    events.push({ ...base, ...draft, keySha256: draftKey(draft) });

  const previous = group(before.observations);
  const current = group(after.observations);
  for (const [id, { key, values: was }] of previous) {
    const now = current.get(id)?.values ?? new Map<string, Observation>();
    const wallet = isWalletProperty(key.property);
    const gone = [...was.keys()].filter((v) => !now.has(v));
    const added = [...now.keys()].filter((v) => !was.has(v));
    if (now.size === 0) {
      for (const value of gone) {
        const o = was.get(value)!;
        const reason = suppression(o, before, after);
        if (reason) suppressed.push({ key, reason, lastSeenCaptureId: o.captureId });
        else push({ kind: 'REMOVED', key, before: value, beforeCaptureId: o.captureId, wallet });
      }
      continue;
    }
    if (was.size === 1 && now.size === 1 && gone.length === 1 && added.length === 1) {
      const [oldValue] = gone as [string];
      const [newValue] = added as [string];
      push({
        kind: 'VALUE_CHANGED',
        key,
        before: oldValue,
        after: newValue,
        beforeCaptureId: was.get(oldValue)!.captureId,
        afterCaptureId: now.get(newValue)!.captureId,
        wallet,
      });
      continue;
    }
    for (const value of gone)
      push({ kind: 'REMOVED', key, before: value, beforeCaptureId: was.get(value)!.captureId, wallet });
    for (const value of added)
      push({ kind: 'ADDED', key, after: value, afterCaptureId: now.get(value)!.captureId, wallet });
  }
  for (const [id, { key, values }] of current) {
    if (previous.has(id)) continue;
    const wallet = isWalletProperty(key.property);
    for (const [value, o] of values) push({ kind: 'ADDED', key, after: value, afterCaptureId: o.captureId, wallet });
  }

  const dataChanged = events.length > 0;
  const algorithmChanged =
    before.algorithm.algorithmVersion !== after.algorithm.algorithmVersion ||
    before.algorithm.weightsVersion !== after.algorithm.weightsVersion;
  // A claim is (identity, address, relation): two relations for one address are two claims.
  const linkKey = (a: RunSnapshot['assessments'][number]) => `${a.identityId}|${addressKey(a.address)}|${a.relation}`;
  const linkLocator = (a: RunSnapshot['assessments'][number]) => `${addressKey(a.address)}#${a.relation}`;
  const oldLinks = new Map(before.assessments.map((a) => [linkKey(a), a]));
  for (const link of after.assessments) {
    const old = oldLinks.get(linkKey(link));
    const key: Key = {
      identityId: link.identityId,
      platform: 'link',
      locator: linkLocator(link),
      property: 'link.score',
    };
    if (!old) {
      push({ kind: 'ADDED', key, after: String(link.score), scoreAfter: link.score, wallet: false });
    } else if (Math.abs(link.score - old.score) >= scoreDeltaMin) {
      push({
        kind: 'SCORE_CHANGED',
        key,
        before: String(old.score),
        after: String(link.score),
        scoreBefore: old.score,
        scoreAfter: link.score,
        cause: dataChanged && algorithmChanged ? 'both' : algorithmChanged ? 'algorithm' : 'data',
        wallet: false,
      });
    }
    oldLinks.delete(linkKey(link));
  }
  for (const old of oldLinks.values()) {
    const key: Key = {
      identityId: old.identityId,
      platform: 'link',
      locator: linkLocator(old),
      property: 'link.score',
    };
    push({ kind: 'REMOVED', key, before: String(old.score), scoreBefore: old.score, wallet: false });
  }

  const order = (e: ChangeEventDraft) =>
    `${CHANGE_KINDS.indexOf(e.kind)}|${keyString(e.key)}|${e.before ?? ''}|${e.after ?? ''}`;
  const sorted = events.toSorted((a, b) => order(a).localeCompare(order(b)));
  const counts = Object.fromEntries(CHANGE_KINDS.map((k) => [k, events.filter((e) => e.kind === k).length])) as Record<
    ChangeKind,
    number
  >;
  return { events: sorted, summary: { ...base, diffVersion: DIFF_VERSION, counts, suppressed } };
}
