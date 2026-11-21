/** Pure helpers for the run comparison: alert grouping and character-level highlighting of swapped values. */
import type { ChangeKind } from '@olcys/core';
import { isWalletSwap, type ChangeView } from '../../lib/domain.ts';

export const CHANGE_KIND_ORDER: readonly ChangeKind[] = ['ADDED', 'REMOVED', 'VALUE_CHANGED', 'SCORE_CHANGED'];

/** Wallet swaps become alerts and are not repeated in the VALUE_CHANGED group. */
export function groupChanges(changes: readonly ChangeView[]): {
  alerts: ChangeView[];
  byKind: Record<ChangeKind, ChangeView[]>;
} {
  const alerts = changes.filter(isWalletSwap);
  const byKind = Object.fromEntries(CHANGE_KIND_ORDER.map((kind) => [kind, [] as ChangeView[]])) as Record<
    ChangeKind,
    ChangeView[]
  >;
  for (const change of changes) {
    if (isWalletSwap(change)) continue;
    (byKind[change.kind] ??= []).push(change);
  }
  return { alerts, byKind };
}

export interface DiffPart {
  text: string;
  changed: boolean;
  /** Position of the part in the original string (stable React key). */
  offset: number;
}

/** Common prefix and suffix stay plain; the differing middle is marked (enough to show a swapped address). */
export function diffParts(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  const split = (value: string): DiffPart[] =>
    [
      { text: value.slice(0, prefix), changed: false, offset: 0 },
      { text: value.slice(prefix, value.length - suffix), changed: true, offset: prefix },
      { text: value.slice(value.length - suffix), changed: false, offset: value.length - suffix },
    ].filter((part) => part.text.length > 0);
  return { before: split(before), after: split(after) };
}
