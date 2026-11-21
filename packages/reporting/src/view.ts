/**
 * Derived, read-only indexes over `ReportData` used by every section: capture register numbers, address roles,
 * accepted vs rejected links, score bands and trace synergy. Pure and deterministic (code-unit ordering only).
 */
import { createHash } from 'node:crypto';
import type {
  AddressCandidate,
  AddressLabel,
  AnalyticConfidence,
  Capture,
  ExclusionDecision,
  Id,
  Identifier,
  LinkAssessment,
  Observation,
  OnlineAccount,
} from '@olcys/core';
import { canonicalJson, isAddressValuedProperty } from '@olcys/core';
import { pl } from './i18n/pl.ts';
import type { ReportData } from './types.ts';

export const BAND_IDS = ['very_high', 'probable', 'medium', 'low', 'excluded'] as const;
export type BandId = (typeof BAND_IDS)[number];

/** Score bands of the challenge brief; `excluded` only for addresses rejected by an exclusion rule. */
export function scoreBand(score: number, excluded = false): BandId {
  if (excluded) return 'excluded';
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'probable';
  if (score >= 40) return 'medium';
  return 'low';
}

/** ICD 203 likelihood scale (upper bounds), identical to `scales.icd203` in config/scoring/weights.v1.yaml. */
export const ICD203_SCALE = [
  { max: 0.05, term: 'almost no chance' },
  { max: 0.2, term: 'very unlikely' },
  { max: 0.45, term: 'unlikely' },
  { max: 0.55, term: 'roughly even chance' },
  { max: 0.8, term: 'likely' },
  { max: 0.95, term: 'very likely' },
  { max: 1, term: 'almost certain' },
] as const;

/** Polish ICD 203 term of a link: the stored term when known, otherwise derived from the probability. */
export function icdTerm(link: Pick<LinkAssessment, 'icd203' | 'probability'>): string {
  const stored = link.icd203 ? pl.icd203[link.icd203] : undefined;
  if (stored) return stored;
  if (link.icd203 && !Number.isFinite(link.probability)) return link.icd203;
  const p = Number.isFinite(link.probability) ? link.probability : 0;
  const entry = ICD203_SCALE.find((s) => p <= s.max) ?? ICD203_SCALE[6];
  return pl.icd203[entry.term] ?? entry.term;
}

const CONFIDENCE_ORDER: readonly AnalyticConfidence[] = ['Low', 'Moderate', 'High'];

export function lowestConfidence(levels: readonly AnalyticConfidence[]): AnalyticConfidence | undefined {
  return CONFIDENCE_ORDER.find((level) => levels.includes(level));
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function timeOf(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Case-insensitive comparison key for hex (EVM) and bech32 addresses; other encodings are case-sensitive. */
export function normAddress(address: string): string {
  return /^0x[0-9a-f]+$/i.test(address) || /^(bc|tb|bcrt|ltc)1/i.test(address) ? address.toLowerCase() : address;
}

const REMOVING_OUTCOMES = new Set<ExclusionDecision['outcome']>(['excluded', 'reclassified']);
const NON_OWNERSHIP = new Set<string>(['THIRD_PARTY_ATTRIBUTION', 'CUSTODIAL_EXCHANGE']);

export interface AddressRole {
  kind: 'linked' | 'excluded' | 'third_party' | 'labelled' | 'unknown';
  link?: LinkAssessment;
  exclusion?: ExclusionDecision;
  label?: AddressLabel;
}

export interface SynergySource {
  sourceId: string;
  pages: number;
}

export interface View {
  data: ReportData;
  dataSha256: string;
  captures: Capture[];
  captureById: Map<Id, Capture>;
  captureNo: Map<Id, number>;
  identityById: Map<Id, Identifier>;
  accountById: Map<Id, OnlineAccount>;
  observationById: Map<Id, Observation>;
  candidateById: Map<Id, AddressCandidate>;
  /** Accepted ownership links, highest score first. */
  linked: LinkAssessment[];
  thirdParty: LinkAssessment[];
  /** Exclusion decisions that remove or reclassify the address (A1–A8), ordered by rule and address. */
  removing: ExclusionDecision[];
  kept: ExclusionDecision[];
  sourceName(id: string): string;
  labelsFor(address: string): AddressLabel[];
  exclusionsFor(address: string): ExclusionDecision[];
  candidatesFor(address: string): AddressCandidate[];
  /** Address-valued observations whose value is the address. */
  observationsFor(address: string): Observation[];
  roleOf(address: string): AddressRole;
  synergy(address: string): SynergySource[];
  identityLabel(identityId: Id): string;
}

function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function isRemoved(link: LinkAssessment, exclusions: readonly ExclusionDecision[]): boolean {
  if (NON_OWNERSHIP.has(link.relation)) return true;
  if (exclusions.some((e) => REMOVING_OUTCOMES.has(e.outcome))) return true;
  return (link.gates ?? []).some((g) => g.gate === 'exclusion' && !g.passed);
}

/**
 * Canonical JSON (RFC 8785) of the report data, stored next to the HTML; its SHA-256 is printed in the report.
 * A JSON round trip first drops `undefined` members and turns non-finite numbers into `null`.
 */
export function reportDataJson(data: ReportData): string {
  return canonicalJson(JSON.parse(JSON.stringify(data)));
}

const byTime = (a: Capture, b: Capture) => timeOf(a.collectedAt) - timeOf(b.collectedAt) || cmp(a.id, b.id);
const exclusionOrder = (a: ExclusionDecision, b: ExclusionDecision) =>
  cmp(a.ruleId, b.ruleId) || cmp(a.address.address, b.address.address) || cmp(a.id, b.id);

export function buildView(data: ReportData): View {
  const dataSha256 = createHash('sha256').update(reportDataJson(data)).digest('hex');
  const own = data.captures.toSorted(byTime);
  const ownIds = new Set(own.map((c) => c.id));
  const earlier = data.earlierCaptures.filter((c) => !ownIds.has(c.id)).toSorted(byTime);
  const captures = [...own, ...earlier];
  const captureNo = new Map(captures.map((c, i) => [c.id, i + 1]));
  const captureById = new Map(captures.map((c) => [c.id, c]));

  const sourceNames = new Map(data.sources.map((s) => [s.id, s.name]));
  const labelsByAddr = group(data.labels, (l) => normAddress(l.address.address));
  const exclusionsByAddr = group(data.exclusions, (e) => normAddress(e.address.address));
  const candidatesByAddr = group(data.candidates, (c) => normAddress(c.address.address));
  const addressObservations = group(
    data.observations.filter((o) => isAddressValuedProperty(o.property)),
    (o) => normAddress(o.value.trim()),
  );
  const exclusionsFor = (address: string) => exclusionsByAddr.get(normAddress(address)) ?? [];

  const links = data.links.toSorted(
    (a, b) => b.score - a.score || cmp(a.address.address, b.address.address) || cmp(a.id, b.id),
  );
  const linked = links.filter((l) => !isRemoved(l, exclusionsFor(l.address.address)));
  const thirdParty = links.filter(
    (l) =>
      l.relation === 'THIRD_PARTY_ATTRIBUTION' &&
      !exclusionsFor(l.address.address).some((e) => REMOVING_OUTCOMES.has(e.outcome)),
  );
  const removing = data.exclusions.filter((e) => e.outcome !== 'kept').toSorted(exclusionOrder);
  const kept = data.exclusions.filter((e) => e.outcome === 'kept').toSorted(exclusionOrder);
  const identityById = new Map(data.case.identifiers.map((i) => [i.id, i]));

  const view: View = {
    data,
    dataSha256,
    captures,
    captureById,
    captureNo,
    identityById,
    accountById: new Map(data.accounts.map((a) => [a.id, a])),
    observationById: new Map(data.observations.map((o) => [o.id, o])),
    candidateById: new Map(data.candidates.map((c) => [c.id, c])),
    linked,
    thirdParty,
    removing,
    kept,
    sourceName: (id) => sourceNames.get(id) ?? id,
    labelsFor: (address) =>
      (labelsByAddr.get(normAddress(address)) ?? []).toSorted(
        (a, b) => b.confidence - a.confidence || cmp(a.entity, b.entity),
      ),
    exclusionsFor,
    candidatesFor: (address) => candidatesByAddr.get(normAddress(address)) ?? [],
    observationsFor: (address) => addressObservations.get(normAddress(address)) ?? [],
    roleOf(address) {
      const exclusion = exclusionsFor(address).find((e) => e.outcome !== 'kept');
      const label = view.labelsFor(address)[0];
      if (exclusion) return { kind: 'excluded', exclusion, ...(label ? { label } : {}) };
      const link = linked.find((l) => normAddress(l.address.address) === normAddress(address));
      if (link) return { kind: 'linked', link };
      const third = thirdParty.find((l) => normAddress(l.address.address) === normAddress(address));
      if (third) return { kind: 'third_party', link: third };
      if (label) return { kind: 'labelled', label };
      return { kind: 'unknown' };
    },
    synergy(address) {
      const pages = new Map<string, Set<string>>();
      const add = (sourceId: string, captureId: string) => {
        const set = pages.get(sourceId) ?? new Set<string>();
        set.add(captureId);
        pages.set(sourceId, set);
      };
      for (const c of view.candidatesFor(address)) {
        const capture = captureById.get(c.captureId);
        if (capture) add(capture.sourceId, c.captureId);
      }
      for (const o of view.observationsFor(address)) add(o.sourceId, o.captureId);
      return [...pages.entries()]
        .map(([sourceId, set]) => ({ sourceId, pages: set.size }))
        .toSorted((a, b) => cmp(a.sourceId, b.sourceId));
    },
    identityLabel(identityId) {
      const identity = identityById.get(identityId);
      return identity ? identity.value : identityId;
    },
  };
  return view;
}
