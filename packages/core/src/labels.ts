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

/** Output script type of a UTXO address, derived locally from its encoding. */
export const UTXO_SCRIPT_TYPES = ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr', 'unknown'] as const;
export type UtxoScriptType = (typeof UTXO_SCRIPT_TYPES)[number];

/** On-chain checks of the address-type classifier, in the order they run. */
export const ADDRESS_TYPE_PROBES = ['code', 'safe', 'erc4337', 'token', 'implementation'] as const;
export type AddressTypeProbe = (typeof ADDRESS_TYPE_PROBES)[number];

/**
 * Address type "as of the recorded chain tip" (state reads use `latest`; a later run may differ). Deployed code alone
 * does not make an address a service: an EIP-7702 delegated EOA has code yet stays key-controlled, and Safes and
 * ERC-4337 accounts are often personal wallets.
 */
export interface AddressTypeClassification {
  address: AddressRef;
  type: AddressType;
  /** First bytes of the deployed code: `0xef0100` for an EIP-7702 delegation, else the first 4 bytes. */
  codePrefix?: string;
  /** Length of the deployed code in bytes (`0` for an account without code). */
  codeSize?: number;
  /** EIP-7702: the delegate the account's code designates (lower-case). */
  delegate?: string;
  /** Safe: the singleton (master copy) the proxy keeps in storage slot 0 (lower-case). */
  safeMasterCopy?: string;
  /** ERC-4337: the EntryPoint the account's `entryPoint()` returns (lower-case). */
  entryPoint?: string;
  /** ERC-1967 implementation of a proxy contract (informational, lower-case). */
  implementation?: string;
  /** UTXO chains: the script type of the address encoding. */
  scriptType?: UtxoScriptType;
  /**
   * A probe that failed (e.g. rate limited): the type is then the most specific one the completed probes support —
   * `unknown` when a personal smart account could not be ruled out.
   */
  failedProbe?: { probe: AddressTypeProbe; message: string };
  /** Requests the classification made (contract code first, then every probe), in call order. */
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
  /**
   * For a candidate whose EVM network was not attributed (`evm:unknown`): the address on the network its chain data
   * was fetched on — the address type and transfers behind the decision belong to it.
   */
  resolved?: AddressRef;
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
      /**
       * Identity of the matched transfers inside their transactions (one transaction may move several assets):
       * the asset key (token contract, else native symbol), and the kind and index of each leg.
       */
      assetKey?: string;
      receiveKind?: 'native' | 'token' | 'internal';
      receiveIndex?: number;
      forwardKind?: 'native' | 'token' | 'internal';
      forwardIndex?: number;
    }[];
    /** A4: the subject published the deposit address (a KYC lead for the exchange). */
    kycLead?: boolean;
    /** A3: delegate of an EIP-7702 delegated account. */
    delegate?: string;
    /** A3: the delegate's entry in the delegate registry (a wallet implementation or a known sweeper). */
    delegateInfo?: { kind: 'wallet_implementation' | 'sweeper'; name: string; source: string };
    /** A2/A3: first bytes and length of the deployed code. */
    codePrefix?: string;
    codeBytes?: number;
    /** A8: the deny-list entry that matched. */
    denyList?: { kind: string; name: string; source: string };
    /** A7: the co-spend cluster behind the flag (a heuristic result). */
    cluster?: {
      id: string;
      size: number;
      previousSize?: number;
      growthFactor?: number;
      /** Labelled services spent together with the cluster. */
      serviceMembers?: string[];
      capped?: boolean;
    };
    /** Rule parameters used, e.g. `{ tauBlocks: 3200, alpha: '0.01', clock: 'blocks' }`. */
    params?: Record<string, number | string>;
  };
  /** Set when the decision is itself a cash-out indicator (A4 → B1). */
  emitsCashOut?: 'B1';
  rulesVersion: string;
}
