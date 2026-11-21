import type { AddressRef } from './chains.ts';
import type { DecimalString, Id, IsoDate, IsoDateTime } from './common.ts';
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

/**
 * Kind of label dataset, in trust order: an exchange's own proof-of-reserves file first, a curated note last.
 * Only datasets whose licence and kind allow it may decide an exclusion (`LabelProvenance.deciding`).
 */
export const LABEL_SOURCE_TYPES = ['por_file', 'graphsense_tagpack', 'ofac', 'etherscan_derived', 'curated'] as const;
export type LabelSourceType = (typeof LABEL_SOURCE_TYPES)[number];

export interface LabelProvenance {
  /** e.g. `graphsense-tagpacks`, `ofac-0xb10c`, `okx-por-2026-11-20`, `esma-casps`, `demo-curated`. */
  datasetId: string;
  url: string;
  /** SPDX id or licence name of the dataset. */
  license: string;
  lastmod: IsoDateTime;
  retrievedAt: IsoDateTime;
  /** Dataset version the label was read from. */
  version?: string;
  sourceType?: LabelSourceType;
  /** True when the dataset may decide an exclusion on its own (licence and kind allow it). Missing means false. */
  deciding?: boolean;
  /** Set for synthetic demo datasets. */
  synthetic?: boolean;
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
  /** English engine sentence starting with the rule id, e.g. `A4: forwards …`; the UI shows Polish rule titles. */
  reason: string;
  evidence: {
    labelIds?: Id[];
    txHashes?: string[];
    kappa?: number;
    fetchIds?: Id[];
    /** A4: the labelled hot wallet the address forwards deposits to. */
    forwardsTo?: { address: string; entity: string; category: EntityCategory; labelId: Id };
    /** A4: matched receive → forward pairs (`delta` in blocks or seconds, see `params.clock`). */
    pairs?: {
      receiveTx: string;
      forwardTx: string;
      amountIn: DecimalString;
      amountOut: DecimalString;
      delta: number;
      kappa: number;
      /** The labelled hot wallet this forward went to (pairs of one address may reach different exchanges). */
      forwardsTo?: { address: string; entity: string; category: EntityCategory; labelId: Id };
    }[];
    /** A4: the subject published the deposit address (a KYC lead for the exchange). */
    kycLead?: boolean;
    /** A3: delegate of an EIP-7702 delegated account. */
    delegate?: string;
    /** A2/A3: first bytes and length of the deployed code. */
    codePrefix?: string;
    codeBytes?: number;
    /** A8: the deny-list entry that matched. */
    denyList?: { kind: string; name: string; source: string };
    /** Rule parameters used, e.g. `{ tauBlocks: 3200, alpha: '0.01', clock: 'blocks' }`. */
    params?: Record<string, number | string>;
  };
  /** Set when the decision is itself a cash-out indicator (A4 → B1). */
  emitsCashOut?: 'B1';
  rulesVersion: string;
}
