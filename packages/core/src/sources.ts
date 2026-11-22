/**
 * OSINT sources and data providers, with their compliance status.
 *
 * GREEN  usable by default.
 * AMBER  disabled by default; an analyst enables it per case, with a justification that is logged.
 * RED    must never be contacted automatically; enforced in code.
 */
export const COMPLIANCE_STATUSES = ['GREEN', 'AMBER', 'RED'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

/** NATO/Admiralty source-reliability grade. F ("cannot be judged") forces an analyst to grade before the evidence counts. */
export const ADMIRALTY_RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type AdmiraltyReliability = (typeof ADMIRALTY_RELIABILITY)[number];

/** Key of an entry in config/sources.yaml, e.g. `bitcointalk`, `keybase`, `mempool_space`. */
export type SourceId = string;

export const SOURCE_KINDS = [
  'forum',
  'social',
  'identity_protocol',
  'code_hosting',
  'messenger_public',
  'registry',
  'archive',
  'search',
  'web',
  'username_enumeration',
  'chain_data',
  'price_fx',
  'timestamping',
  'label_dataset',
  'fixture',
  'internal_service',
  'ai_model',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface RateLimit {
  requests: number;
  perSeconds: number;
}

export interface SourceDescriptor {
  id: SourceId;
  name: string;
  kind: SourceKind;
  compliance: ComplianceStatus;
  /** Why the source has this status (ToS clause, licence, data-flow concern). */
  complianceNote: string;
  /** Link to the terms (or the documentation that holds the usage rules); `null` = no published terms. */
  tosUrl: string | null;
  /** Polish display name / note for the analyst console. */
  namePl: string;
  complianceNotePl: string;
  /** False excludes this source's content from every LLM prompt (e.g. Telegram). Default true. */
  llmAllowed?: boolean;
  /** Hosts that must never be contacted even if allowed elsewhere (required and non-empty for RED sources). */
  blockedHosts?: string[];
  /** Attribution text required by the provider's terms (e.g. "Powered by Etherscan.io APIs"). */
  attribution?: string;
  /** True for a local sandbox chain (demo wallets only): every response from it is marked `sandbox` in provenance. */
  sandbox?: boolean;
  enabledByDefault: boolean;
  requiresApiKey: boolean;
  /** True when a query to this source discloses a case identifier to a third party (logged per request). */
  sendsIdentifiersExternally: boolean;
  /** Default reliability grade for evidence originating here. */
  reliability: AdmiraltyReliability;
  rateLimit: RateLimit;
  /** Hostnames this source may contact; the egress allow-list is the union over enabled sources. */
  allowedHosts: string[];
}
