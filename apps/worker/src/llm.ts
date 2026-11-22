/**
 * The AI model of the composition root: `@olcys/llm` on a dedicated egress client that knows only the register entry
 * named by `LLM_SOURCE_ID` (default `local_llm`), so the model endpoint is allow-listed, rate-limited and logged like
 * every other source. Every call is appended to `llm_call`. The model only suggests (zero score weight).
 */
import type { BlobStore, FetchMode, LlmClient, Repositories, SourceDescriptor } from '@olcys/core';
import { createEgressClient } from '@olcys/http';
import { createLlmClient, llmConfigFromEnv, type LlmConfig } from '@olcys/llm';
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

export function createLlmRuntime(options: LlmRuntimeOptions): LlmRuntime {
  const { repos, blobs } = options;
  const config = llmConfigFromEnv(options.env);
  const llmRepo = repos.llm;
  if (!llmRepo) throw new Error('the repositories keep no model calls (Repositories.llm)');
  const source = options.sources.find((s) => s.id === config.sourceId);
  if (config.enabled && !source) throw new Error(`LLM_SOURCE_ID ${config.sourceId} is not in config/sources.yaml`);
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
    log: { append: (record) => llmRepo.addCall(record) },
    clock: { now: () => new Date() },
    config,
  });
  return { client, config };
}
