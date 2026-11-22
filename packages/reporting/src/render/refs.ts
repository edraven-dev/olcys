/**
 * Where a cited id of the report model (a fact or a computed result) can be followed to in the HTML report: the
 * evidence register entry of the capture for a fact, the card of the link, rejection or address for a computed
 * result, or the section that holds it. Used by AI-assisted inferences, so no cited id stays a bare identifier.
 */
import { refKey, type View } from '../view.ts';

const ACTIVITY_PREFIX = 'activity-';
const VALUATION_SUFFIX = '-valuation';

/** The in-document anchor (`#…`) of a cited id, or `undefined` when the id is not part of this report. */
export function citedHref(view: View, id: string): string | undefined {
  const { data } = view;
  const captureId =
    data.observations.find((o) => o.id === id)?.captureId ?? data.candidates.find((c) => c.id === id)?.captureId;
  if (captureId !== undefined) {
    const n = view.captureNo.get(captureId);
    return n === undefined ? '#rejestr' : `#zab-${n}`;
  }
  if (data.links.some((l) => l.id === id))
    return view.linked.some((l) => l.id === id) ? `#powiazanie-${id}` : '#powiazania';
  if (data.exclusions.some((e) => e.id === id))
    return view.removing.some((e) => e.id === id) ? `#odrzucony-${id}` : '#odrzucone';
  if (id.startsWith(ACTIVITY_PREFIX)) {
    const activity = data.activity.find((a) => refKey(a.address) === id.slice(ACTIVITY_PREFIX.length));
    if (activity) return `#aktywnosc-${refKey(activity.address)}`;
  }
  const eventId = id.endsWith(VALUATION_SUFFIX) ? id.slice(0, -VALUATION_SUFFIX.length) : id;
  const cashOut = data.cashOuts.find((e) => e.id === eventId);
  if (cashOut) return `#aktywnosc-${refKey(cashOut.address)}`;
  if (id.startsWith('rejected-')) return '#odrzucone';
  return undefined;
}
