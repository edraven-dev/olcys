import type { Relation, RoleCue } from '@olcys/core';

/** The relation a truth role must lead to under the versioned relation rules (cue → relation table). */
export function expectedRelation(role: RoleCue | 'none'): Relation {
  switch (role) {
    case 'first_person_owner':
      return 'SELF_DECLARED';
    case 'payment_request':
    case 'donation':
      return 'PAYMENT_ENDPOINT';
    case 'exchange_deposit':
      return 'CUSTODIAL_EXCHANGE';
    case 'scam_report':
    case 'warning':
      return 'THIRD_PARTY_ATTRIBUTION';
    case 'listing':
    case 'quote':
    case 'unclear':
    case 'none':
      return 'MENTION_UNCLEAR';
  }
}

export interface RelationPair {
  truth: Relation;
  predicted: Relation;
}

export interface RelationAccuracy {
  macroF1: number;
  confusion: Record<string, Record<string, number>>;
}

/** Confusion matrix (truth → predicted → count) and macro-F1 over the classes that occur as truth or prediction. */
export function relationAccuracy(pairs: readonly RelationPair[]): RelationAccuracy {
  const confusion: Record<string, Record<string, number>> = {};
  const classes = new Set<string>();
  for (const { truth, predicted } of pairs) {
    classes.add(truth);
    classes.add(predicted);
    const row = (confusion[truth] ??= {});
    row[predicted] = (row[predicted] ?? 0) + 1;
  }
  const sortedClasses = [...classes].toSorted();
  const sorted: Record<string, Record<string, number>> = {};
  for (const t of Object.keys(confusion).toSorted()) {
    sorted[t] = Object.fromEntries(Object.entries(confusion[t] ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1)));
  }
  const f1s = sortedClasses.map((c) => {
    const tp = confusion[c]?.[c] ?? 0;
    const fp = pairs.filter((p) => p.predicted === c && p.truth !== c).length;
    const fn = pairs.filter((p) => p.truth === c && p.predicted !== c).length;
    return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  return { macroF1: f1s.length === 0 ? 0 : f1s.reduce((s, v) => s + v, 0) / f1s.length, confusion: sorted };
}
