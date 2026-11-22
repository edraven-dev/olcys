/**
 * Versioned prompt registry. A prompt's hash covers everything that shapes the call; released versions are immutable
 * (`prompts.lock.json` pins `<task>@<version>` to its hash), so a changed prompt needs a new version.
 */
import { canonicalJson, parse, toJsonSchema, type LlmRequest, type Sha256Hex } from '@olcys/core';
import { createHash } from 'node:crypto';
import type { z } from 'zod';

export type Schema<T> = z.ZodType<T>;

export interface PromptDefinition<T> {
  task: string;
  version: string;
  language: 'pl';
  /** The system prompt; it must say that delimited text is data, never instructions. */
  system: string;
  schema: Schema<T>;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  seed: number;
  /** Longer input is rejected, not truncated: callers window their text. */
  maxInputChars: number;
  sha256: Sha256Hex;
}

export type PromptSource<T> = Omit<PromptDefinition<T>, 'jsonSchema' | 'sha256'>;

const registry = new Map<string, PromptDefinition<unknown>>();

export const promptKey = (task: string, version: string): string => `${task}@${version}`;

/** Compares versions such as `v2` and `v10` numerically. */
const versionNumber = (version: string): number => Number(/(\d+)$/.exec(version)?.[1] ?? 0);

export function promptSha256(p: Omit<PromptDefinition<unknown>, 'sha256' | 'schema'>): Sha256Hex {
  return createHash('sha256')
    .update(
      canonicalJson({
        task: p.task,
        version: p.version,
        language: p.language,
        system: p.system,
        jsonSchema: p.jsonSchema,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        seed: p.seed,
        maxInputChars: p.maxInputChars,
      }),
    )
    .digest('hex');
}

/** Builds and registers a prompt. Registering a different definition under a taken `<task>@<version>` throws. */
export function definePrompt<T>(source: PromptSource<T>): PromptDefinition<T> {
  const { $schema: _ignored, ...jsonSchema } = toJsonSchema(source.schema) as Record<string, unknown>;
  const prompt: PromptDefinition<T> = { ...source, jsonSchema, sha256: promptSha256({ ...source, jsonSchema }) };
  const key = promptKey(prompt.task, prompt.version);
  const existing = registry.get(key);
  if (existing && existing.sha256 !== prompt.sha256) {
    throw new Error(`prompt ${key} is already registered with a different definition`);
  }
  registry.set(key, prompt as PromptDefinition<unknown>);
  return prompt;
}

/** The prompt of `task` at `version`, or its latest version when omitted. */
export function getPrompt(task: string, version?: string): PromptDefinition<unknown> {
  if (version !== undefined) {
    const found = registry.get(promptKey(task, version));
    if (!found) throw new Error(`unknown prompt ${promptKey(task, version)}`);
    return found;
  }
  const versions = [...registry.values()].filter((p) => p.task === task);
  const latest = versions.toSorted((a, b) => versionNumber(b.version) - versionNumber(a.version))[0];
  if (!latest) throw new Error(`unknown prompt task ${task}`);
  return latest;
}

export function listPrompts(): PromptDefinition<unknown>[] {
  return [...registry.values()];
}

export function buildLlmRequest<T>(
  p: PromptDefinition<T>,
  input: Pick<LlmRequest<T>, 'untrustedInput' | 'inputs' | 'containsIdentifier' | 'runId' | 'caseId'>,
): LlmRequest<T> {
  return {
    task: p.task,
    promptVersion: p.version,
    promptSha256: p.sha256,
    system: p.system,
    untrustedInput: input.untrustedInput,
    inputs: input.inputs,
    jsonSchema: p.jsonSchema,
    parseOutput: (value) => parse(p.schema, value),
    maxTokens: p.maxTokens,
    temperature: p.temperature,
    seed: p.seed,
    maxInputChars: p.maxInputChars,
    containsIdentifier: input.containsIdentifier,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
  };
}
