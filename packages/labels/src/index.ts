/**
 * @olcys/labels — address labels with provenance, address-type classification and the misattribution rules
 * (A1 labelled service, A2 contract code, A3 EIP-7702 delegation, A4 exchange deposit address, A8 deny list).
 *
 * Contracts (types and ports) come from @olcys/core.
 */
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
  classifyAddressType,
  effectiveOutcome,
  evaluateExclusions,
  isExcluded,
  prescreenExclusions,
  type AddressFacts,
  type ExclusionDeps,
} from './exclusions.ts';
export { canonicalAddress, chainMatches, MemoryLabelLookup, rankLabels } from './lookup.ts';
