/**
 * The AI model of the composition root: `@olcys/llm` on a dedicated egress client that knows only the register entry
 * named by `LLM_SOURCE_ID` (default `local_llm`), so the model endpoint is allow-listed, rate-limited and logged like
 * every other source. Every call is appended to `llm_call`. The model only suggests (zero score weight).
 */
import type { BlobStore, FetchMode, LlmClient, Repositories, SourceDescriptor } from '@olcys/core';
import { createEgressClient } from '@olcys/http';
import { createLlmClient, llmConfigFromEnv, llmSourceProblem, type LlmConfig } from '@olcys/llm';
import { TOOL_VERSION } from './config.ts';

export interface LlmRuntime {
  client: LlmClient;
  config: LlmConfig;
}

export interface LlmRuntimeOptions {
  env: Readonly<Record<string, string | undefined>>;
  repos: Repositories;
  blobs: BlobStore;
  sources: readonly SourceDescriptor[];
  mode: FetchMode;
}

/** A model source the register does not allow for case text (`code` is stable for callers and tests). */
export class LlmConfigError extends Error {
  readonly code = 'llm_source_not_allowed';
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export function createLlmRuntime(options: LlmRuntimeOptions): LlmRuntime {
  const { repos, blobs } = options;
  const config = llmConfigFromEnv(options.env);
  const source = options.sources.find((s) => s.id === config.sourceId);
  const llmRepo = repos.llm;
  if (config.enabled) {
    // Only a GREEN local model may see case text: a remote (AMBER) endpoint needs case-scoped approval (not in the MVP).
    const problem = llmSourceProblem(source, config.sourceId);
    if (problem) throw new LlmConfigError(`LLM_SOURCE_ID ${config.sourceId}: ${problem}`);
    if (!llmRepo) throw new Error('the repositories keep no model calls (Repositories.llm)');
  }
  const http = createEgressClient({
    mode: options.mode,
    // Without the register entry nothing is enabled, so a (disabled) client can never reach the network.
    enabledSources: source ? [source] : [],
    blobs,
    sinks: {
      log: (entry) => repos.evidence.addEgressLog([entry]),
      provenance: (envelope) => repos.evidence.addRawFetches([envelope]),
    },
    toolVersion: TOOL_VERSION,
  });
  const client = createLlmClient({
    http,
    blobs,
    // A disabled model needs no store: its calls are refused before anything is sent (and logged only when a store exists).
    log: { append: async (record) => llmRepo?.addCall(record) },
    clock: { now: () => new Date() },
    config,
    source,
  });
  return { client, config };
}
