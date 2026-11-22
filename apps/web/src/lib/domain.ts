/**
 * Shapes the console reads from the API: the `@olcys/core` records plus optional fields that newer engine versions
 * add (score band, trace synergy, A4 forwarding detail, wallet flag on changes). Every extra field is optional, so
 * older or partial data still renders. Pure helpers only.
 */
import type {
  AddressRef,
  AnalystJudgement,
  CashOutEvent,
  ChangeEvent,
  ComplianceStatus,
  DecimalString,
  EntityCategory,
  ExclusionDecision,
  Id,
  LinkAssessment,
  LinkPath,
  Relation,
  SourceKind,
} from '@olcys/core';
import { resolveBand, type ScoreBand } from './band.ts';

/** Item of `GET /api/sources`. */
export interface SourceItem {
  id: string;
  name: string;
  kind: SourceKind;
  compliance: ComplianceStatus;
  complianceNote: string;
  enabledByDefault: boolean;
  sendsIdentifiersExternally: boolean;
  reliability?: string;
  tosUrl?: string | null;
}

export interface TraceSynergyView {
  independentSources: string[];
  bestSingleScore: number;
  bonusPoints: number;
  repeatedPaths: number;
  repeatedItems: number;
}

export type LinkPathView = LinkPath & { service?: string; originGroup?: string; counted?: boolean };

export type LinkView = Omit<LinkAssessment, 'paths'> & {
  paths: LinkPathView[];
  band?: string;
  ungated?: { probability: number; score: number; icd203: string };
  synergy?: TraceSynergyView;
  /** Analyst judgements recorded next to the link (oldest first); they never change the computed fields. */
  judgements?: AnalystJudgement[];
};

export type ExclusionView = Omit<ExclusionDecision, 'evidence'> & {
  evidence: ExclusionDecision['evidence'] & {
    forwardsTo?: { address: string; entity: string; category: EntityCategory; labelId?: Id };
    kycLead?: boolean;
    codePrefix?: string;
    codeBytes?: number;
    denyList?: { kind: string; name: string; source: string };
    delegate?: string;
  };
  emitsCashOut?: string;
};

export type ChangeView = ChangeEvent & { wallet?: boolean };

export type CashOutView = CashOutEvent & {
  plnTotal?: DecimalString;
  exclusionDecisionId?: Id;
  components?: { txHash: string; at: string; amount: DecimalString }[];
};

/** `<chain>:<address>`, the same key as `addressKey()` in core. */
export function keyOf(ref: AddressRef): string {
  return `${ref.chain}:${ref.address}`;
}

/** Relations that make no ownership claim (scored 0 by the engine's relation gate). */
const NON_OWNERSHIP: ReadonlySet<Relation> = new Set([
  'THIRD_PARTY_ATTRIBUTION',
  'TX_COUNTERPARTY',
  'CLUSTER_ASSOCIATED',
  'CUSTODIAL_EXCHANGE',
]);
const HARD_GATES: ReadonlySet<string> = new Set(['relation', 'exclusion', 'invalid_checksum']);

/** Exclusion outcomes that take an address out of the subject's holdings. */
export function isRejectingDecision(decision: Pick<ExclusionDecision, 'outcome'>): boolean {
  return decision.outcome === 'excluded' || decision.outcome === 'reclassified';
}

/** True when the link is rejected: band WYKLUCZENIE, a non-ownership relation, a failed hard gate or an exclusion. */
export function isRejectedLink(link: LinkView, excludedKeys: ReadonlySet<string> = new Set()): boolean {
  if (link.band === 'WYKLUCZENIE') return true;
  if (NON_OWNERSHIP.has(link.relation)) return true;
  if (link.gates.some((gate) => !gate.passed && HARD_GATES.has(gate.gate))) return true;
  return excludedKeys.has(keyOf(link.address));
}

export function linkBand(link: LinkView, excludedKeys: ReadonlySet<string> = new Set()): ScoreBand {
  return resolveBand(link, isRejectedLink(link, excludedKeys));
}

/** A main-table link whose every path has a weak identity hop (e.g. the same nick on an unrelated account). */
export function isWeakIdentity(link: LinkView): boolean {
  return link.paths.length > 0 && link.paths.every((path) => path.identityHop.probability < 0.5);
}

const ADDRESS_VALUED = /(?:^|[._])(?:[a-z0-9]+_)?address(?:es|_mention)?$/;

/** Same rule as `isAddressValuedProperty()` in core (kept equal by a test). */
export function isAddressValuedProperty(property: string): boolean {
  const base = property.replace(/\[\d+\]/g, '');
  if (base.startsWith('computed.') || base.startsWith('registry.')) return false;
  return ADDRESS_VALUED.test(base);
}

/** VALUE_CHANGED on an address-valued property: the "wallet swapped on the profile" alert. */
export function isWalletSwap(change: ChangeView): boolean {
  if (change.kind !== 'VALUE_CHANGED') return false;
  return change.wallet ?? isAddressValuedProperty(change.key.property);
}
