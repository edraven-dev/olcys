/**
 * @olcys/labels — address labels with provenance, address-type classification (EOA, EIP-7702 delegated EOA, Safe,
 * ERC-4337 account, token contract, contract, UTXO script type) and the misattribution rules (A1 labelled service,
 * A2 contract code, A3 EIP-7702 delegation, A4 exchange deposit address, A8 deny list).
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export {
  classifyAddress,
  DELEGATION_PREFIX,
  ERC1967_IMPLEMENTATION_SLOT,
  parseDelegation,
  SAFE_SINGLETON_SLOT,
  SELECTORS,
  type ClassifierDeps,
} from './classifier.ts';
export { coSpendGuard, detectCoinJoin, isCollaborativeEscrow, type CoinJoinKind } from './coinjoin.ts';
export {
  buildCoSpendClusters,
  clusterId,
  COSPEND_ALGORITHM_VERSION,
  evaluateClusterCollapse,
  planClusterExpansion,
  toClusterSummary,
  type ClusterSummary,
  type CoSpendDeps,
} from './cospend.ts';
export {
  DENY_KINDS,
  loadDenyList,
  loadExclusionRules,
  type DenyEntry,
  type DenyKind,
  type DenyList,
  type ExclusionRulesConfig,
} from './config.ts';
export {
  decidingAllowed,
  DEMO_CURATED_DATASET,
  LICENSE_CLASSES,
  loadLabelDataset,
  type LabelDatasetMeta,
  type LicenseClass,
} from './datasets.ts';
export {
  effectiveOutcome,
  evaluateExclusions,
  isDecidingService,
  isExcluded,
  prescreenExclusions,
  type AddressFacts,
  type ExclusionDeps,
} from './exclusions.ts';
export { canonicalAddress, chainMatches, MemoryLabelLookup, rankLabels } from './lookup.ts';
export {
  DELEGATE_KINDS,
  findDelegate,
  loadDelegateRegistry,
  loadEntryPoints,
  type DelegateInfo,
  type DelegateKind,
} from './registries.ts';
export { loadSafeSingletons, SAFE_VERSIONS } from './safe-singletons.ts';
export { utxoScriptType } from './utxo-script.ts';
