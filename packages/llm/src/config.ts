import type { LlmConfig } from './client.ts';

export const DEFAULT_LLM_SOURCE_ID = 'local_llm';
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Reads `LLM_*` from the environment. Enabled requires a base URL and a model. */
export function llmConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LlmConfig {
  const text = (name: string): string => env[name]?.trim() ?? '';
  const enabled = text('LLM_ENABLED').toLowerCase() === 'true';
  const baseUrl = text('LLM_BASE_URL');
  const model = text('LLM_MODEL');
  if (enabled && (!baseUrl || !model)) throw new Error('LLM_ENABLED=true needs LLM_BASE_URL and LLM_MODEL');
  const timeoutMs = Number(text('LLM_TIMEOUT_MS') || DEFAULT_LLM_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('LLM_TIMEOUT_MS must be a positive integer');
  let kwargs: Record<string, unknown> | undefined;
  const rawKwargs = text('LLM_CHAT_TEMPLATE_KWARGS');
  if (rawKwargs) {
    const parsed: unknown = JSON.parse(rawKwargs);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LLM_CHAT_TEMPLATE_KWARGS must be a JSON object');
    }
    kwargs = parsed as Record<string, unknown>;
  }
  return {
    enabled,
    baseUrl,
    model,
    ...(text('LLM_API_KEY') ? { apiKey: text('LLM_API_KEY') } : {}),
    ...(text('LLM_MODEL_DIGEST') ? { modelDigest: text('LLM_MODEL_DIGEST') } : {}),
    sourceId: text('LLM_SOURCE_ID') || DEFAULT_LLM_SOURCE_ID,
    timeoutMs,
    ...(kwargs ? { chatTemplateKwargs: kwargs } : {}),
  };
}
