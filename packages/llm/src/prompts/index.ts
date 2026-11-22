/**
 * Registered prompts: one file per task version under `src/prompts/<task>/v<N>.ts`, imported here so that the lock
 * script and the lock test see them. Importing a task file registers it.
 */
export { buildLlmRequest, definePrompt, getPrompt, listPrompts, promptKey, promptSha256 } from './registry.ts';
export type { PromptDefinition, PromptSource, Schema } from './registry.ts';
export { extendLock, lockProblems, type PromptLock } from './lock.ts';
export {
  ADDRESS_ROLE_TASK,
  addressRolePromptV1,
  AddressRoleOutputSchema,
  type AddressRoleOutput,
} from './address-role/v1.ts';
