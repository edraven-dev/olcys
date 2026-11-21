/**
 * @olcys/address-extractor — Detects, validates (checksums) and contextualises crypto addresses in captured content;
 * redacts secrets. Pure and offline: bytes in, `ExtractionResult` out; no network, no logging, no storage.
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export const PACKAGE_NAME = '@olcys/address-extractor';

// Extraction of one capture.
export {
  EXTRACTOR_VERSION,
  extractCapture,
  SecretLeakError,
  type ExtractCaptureResult,
  type ExtractOptions,
} from './extract.ts';
export { REJECT_CODES, type CaptureContent, type RejectCode } from './pipeline-types.ts';

// Deny list (config/rules/deny-list.v1.yaml).
export { createDenyList, EMPTY_DENY_LIST, EXTRACTION_DENY_KINDS, parseDenyList, type DenyList } from './deny-list.ts';

// Single addresses, redaction and role cues.
export { validateAddress, type AddressValidation } from './validate/address.ts';
export { CHECKSUM_BITS, DEOBFUSCATION_TRANSFORMS } from './validate/validate.ts';
export { redactionMarker, redactText } from './patterns/redact.ts';
export { detectRoleCues, type RoleCueExtra } from './context/cues.ts';
export { LEXICON_VERSION, ROLE_LEXICON, type LexiconEntry } from './context/lexicon.ts';
export { PATTERNS_VERSION } from './patterns/patterns.ts';
export { URI_RULES_VERSION } from './attribution/contexts.ts';
export { createSecretRedactor } from './redactor.ts';
