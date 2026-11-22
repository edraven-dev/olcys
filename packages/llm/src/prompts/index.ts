/**
 * Registered prompts: one file per task version under `src/prompts/<task>/v<N>.ts`, imported here so that the lock
 * script and the lock test see them. No task is registered yet.
 */
export { buildLlmRequest, definePrompt, getPrompt, listPrompts, promptKey, promptSha256 } from './registry.ts';
export type { PromptDefinition, PromptSource, Schema } from './registry.ts';
export { extendLock, lockProblems, type PromptLock } from './lock.ts';
