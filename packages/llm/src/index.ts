/**
 * @olcys/llm — OpenAI-compatible model client, versioned prompt registry, JSON-schema outputs and call logging.
 * Suggestions only; never part of the score.
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export const PACKAGE_NAME = '@olcys/llm';
export {
  createLlmClient,
  llmSourceProblem,
  type LlmCallLog,
  type LlmSourceInfo,
  type LlmClientDeps,
  type LlmConfig,
} from './client.ts';
export { DEFAULT_LLM_SOURCE_ID, DEFAULT_LLM_TIMEOUT_MS, llmConfigFromEnv } from './config.ts';
export { sanitizeUntrusted, UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted, type WrappedInput } from './untrusted.ts';
export {
  buildRoleInput,
  classifyAddressMention,
  isLlmAllowed,
  lexiconAgreement,
  MIN_SNIPPET_CHARS,
  spanInInput,
  type AddressRoleSuggestion,
  type RoleClassificationInput,
  type RoleClassificationOutcome,
  type RoleSkipReason,
} from './address-role.ts';
export {
  buildDraftContext,
  draftInferences,
  type DraftContext,
  type DraftInput,
  type DraftOutcome,
  type DraftSuggestion,
} from './inference-draft.ts';
export * from './prompts/index.ts';
export { z } from 'zod';
