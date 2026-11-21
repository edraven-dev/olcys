import type { AddressRef } from './chains.ts';
import type { Id, IsoDate, IsoDateTime } from './common.ts';
import type { Relation } from './scoring.ts';

/** Counterparty taxonomy (GraphSense categories + INTERPOL DW-VA inspired). */
export const ENTITY_CATEGORIES = [
  'exchange',
  'p2p_exchange',
  'payment_gateway',
  'card_program',
  'instant_exchanger',
  'defi_dex',
  'bridge',
  'mixer',
  'gambling',
  'merchant_services',
  'mining_pool',
  'token_contract',
  'smart_contract',
  'personal_smart_account',
  'atm_operator',
  'kantor',
  'sanctioned_entity',
  'scam',
  'unknown_service',
] as const;
export type EntityCategory = (typeof ENTITY_CATEGORIES)[number];

export interface LabelProvenance {
  /** e.g. `graphsense-tagpacks`, `ofac-0xb10c`, `okx-por-2026-11-20`, `esma-casps`, `demo-curated`. */
  datasetId: string;
  url: string;
  /** SPDX id or licence name of the dataset. */
  license: string;
  lastmod: IsoDateTime;
  retrievedAt: IsoDateTime;
}

export interface AddressLabel {
  id: Id;
  address: AddressRef;
  entity: string;
  category: EntityCategory;
  /** Category and sanction status are separate: a delisted mixer is still a mixer. */
  attributes: {
    custodial?: boolean;
    fiatCapable?: boolean;
    euAuthorised?: boolean;
    plRegistered?: boolean;
    kyc?: boolean;
    sanctioned?: boolean;
    activeFrom?: IsoDate;
    activeTo?: IsoDate;
  };
  provenance: LabelProvenance;
  /** 0–100, as given by the dataset or assigned on import. */
  confidence: number;
}

export const ADDRESS_TYPES = [
  'eoa',
  'contract',
  'delegated_eoa',
  'safe',
  'erc4337_account',
  'token_contract',
  'utxo_script',
  'unknown',
] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

export interface AddressTypeClassification {
  address: AddressRef;
  type: AddressType;
  /** First bytes of the deployed code, e.g. `0xef0100` for an EIP-7702 delegation. */
  codePrefix?: string;
  delegate?: string;
  safeMasterCopy?: string;
  fetchIds: Id[];
}

/**
 * Entry kinds of the deny list (`config/rules/deny-list.v1.yaml`). Test vectors and documentation examples are
 * rejected at extraction time; every kind is excluded by rule A8.
 */
export const DENY_LIST_KINDS = ['test_vector', 'documentation', 'burn', 'token_contract'] as const;
export type DenyListKind = (typeof DENY_LIST_KINDS)[number];

/** Misattribution filters. */
export const EXCLUSION_RULE_IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'] as const;
export type ExclusionRuleId = (typeof EXCLUSION_RULE_IDS)[number];

/** Exclusion reclassifies rather than discards: a deposit address is not a holding but is a cash-out lead. */
export interface ExclusionDecision {
  id: Id;
  runId: Id;
  address: AddressRef;
  ruleId: ExclusionRuleId;
  outcome: 'excluded' | 'reclassified' | 'kept' | 'flagged';
  relation?: Relation;
  reason: string;
  evidence: { labelIds?: Id[]; txHashes?: string[]; kappa?: number; fetchIds?: Id[] };
  rulesVersion: string;
}
