/**
 * Small OpenAI-compatible Chat Completions client on the egress client (one POST to `{baseUrl}/chat/completions`),
 * configured only by base URL and model. No SDK, no tools, no streaming, no retries. The model only suggests: output
 * is schema-checked, every attempt is logged, nothing here touches a score.
 */
import { createHash } from 'node:crypto';
import type {
  BlobStore,
  Clock,
  EgressClient,
  Id,
  LlmCallRecord,
  LlmClient,
  LlmFailureCode,
  LlmRequest,
  LlmResult,
  SourceDescriptor,
  SourceId,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { wrapUntrusted } from './untrusted.ts';

export interface LlmConfig {
  enabled: boolean;
  /** e.g. `http://localhost:2140/v3` (the path `/chat/completions` is appended). */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token only when set; never logged. */
  apiKey?: string;
  /** Digest of the served model, recorded with every call (the server does not report it). */
  modelDigest?: string;
  /** Register entry (`config/sources.yaml`) the traffic is attributed to. */
  sourceId: SourceId;
  timeoutMs: number;
  /** Extra template arguments for servers that support them, e.g. `{ "enable_thinking": false }`. */
  chatTemplateKwargs?: Record<string, unknown>;
}

/** The part of the register entry the model traffic is attributed to that decides whether it may carry case text. */
export type LlmSourceInfo = Pick<SourceDescriptor, 'id' | 'kind' | 'compliance' | 'sendsIdentifiersExternally'>;

/**
 * Only a GREEN `ai_model` source that keeps identifiers on this side may be used. A remote (AMBER) endpoint needs
 * case-scoped approval and a justification, which this client does not provide.
 */
export function llmSourceProblem(source: LlmSourceInfo | undefined, sourceId: string): string | undefined {
  if (!source) return `source ${sourceId} is not in the register`;
  if (source.kind !== 'ai_model') return `source ${source.id} is not an ai_model source`;
  if (source.compliance !== 'GREEN') return `source ${source.id} is ${source.compliance}: needs case-scoped approval`;
  if (source.sendsIdentifiersExternally) return `source ${source.id} sends identifiers externally`;
  return undefined;
}

export interface LlmCallLog {
  append(record: LlmCallRecord): Promise<void>;
}

export interface LlmClientDeps {
  http: EgressClient;
  blobs: BlobStore;
  log: LlmCallLog;
  clock: Clock;
  config: LlmConfig;
  /** The register entry of `config.sourceId`; checked on every call (see `llmSourceProblem`). */
  source?: LlmSourceInfo | undefined;
}

const DEFAULT_MAX_TOKENS = 1024;
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

function errorNamed(error: unknown, ...names: string[]): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth += 1) {
    if (names.includes(e.name)) return true;
  }
  return false;
}

/** `fetch failed` (undici TypeError, the cause names the socket error), too many redirects, oversized body. */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  return /^(too many redirects|response body exceeds)/.test(error.message);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const { http, blobs, log, clock, config, source } = deps;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    enabled: config.enabled,

    async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const callId: Id = newId();
      const started = clock.now();
      const record: LlmCallRecord = {
        id: callId,
        ...(request.caseId ? { caseId: request.caseId } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
        task: request.task,
        promptVersion: request.promptVersion,
        promptSha256: request.promptSha256,
        baseUrl: config.baseUrl,
        modelRequested: config.model,
        ...(config.modelDigest ? { modelDigest: config.modelDigest } : {}),
        params: {},
        inputSha256: sha256(request.untrustedInput),
        inputCaptureIds: request.inputs.flatMap((i) => (i.captureId ? [i.captureId] : [])),
        inputSourceIds: [...new Set(request.inputs.map((i) => i.sourceId))],
        outcome: 'ok',
        startedAt: started.toISOString(),
        finishedAt: started.toISOString(),
      };

      /** Logs the attempt and returns the failure (the outcome is the code). */
      const fail = async (code: LlmFailureCode, message: string): Promise<LlmResult<T>> => {
        const finished = clock.now();
        await log.append({
          ...record,
          outcome: code,
          error: message,
          finishedAt: finished.toISOString(),
          latencyMs: finished.getTime() - started.getTime(),
        });
        return { ok: false, code, message, callId };
      };

      // Guards run before any network call.
      if (!config.enabled) return fail('disabled', 'the AI model is disabled (LLM_ENABLED=false)');
      const sourceProblem = llmSourceProblem(source, config.sourceId);
      if (sourceProblem) return fail('egress_denied', sourceProblem);
      const forbidden = request.inputs.filter((i) => !i.llmAllowed);
      if (forbidden.length > 0) {
        const sources = [...new Set(forbidden.map((i) => i.sourceId))].join(', ');
        return fail('input_rejected', `content of a source excluded from model prompts: ${sources}`);
      }
      if (request.maxInputChars !== undefined && request.untrustedInput.length > request.maxInputChars) {
        return fail(
          'input_rejected',
          `input has ${request.untrustedInput.length} characters, the limit is ${request.maxInputChars}`,
        );
      }

      const params = {
        temperature: request.temperature ?? 0,
        seed: request.seed ?? 0,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      record.params = params;
      // No `tools`, `tool_choice`, `functions` or `logprobs`: the model returns text only.
      const body = JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: wrapUntrusted(request.untrustedInput, request.promptSha256).content },
        ],
        temperature: params.temperature,
        seed: params.seed,
        max_tokens: params.max_tokens,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.task, strict: true, schema: request.jsonSchema },
        },
        ...(config.chatTemplateKwargs ? { chat_template_kwargs: config.chatTemplateKwargs } : {}),
      });
      record.requestSha256 = sha256(body);
      record.requestBlob = await blobs.put(new TextEncoder().encode(body), 'application/json');

      let response;
      try {
        response = await http.fetch({
          url: endpoint,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body,
          sourceId: config.sourceId,
          purpose: `llm:${request.task}@${request.promptVersion}`,
          containsIdentifier: request.containsIdentifier,
          ...(request.runId ? { runId: request.runId } : {}),
          timeoutMs: config.timeoutMs,
          secretParams: ['authorization'],
        });
      } catch (error) {
        if (errorNamed(error, 'EgressDeniedError', 'ReplayMissError')) return fail('egress_denied', messageOf(error));
        if (errorNamed(error, 'TimeoutError', 'AbortError')) {
          return fail('timeout', `no answer within ${config.timeoutMs} ms`);
        }
        // Transport failures `@olcys/http` raises for a server that cannot be used: undici's `fetch failed` and the
        // client's own refusals of a runaway answer. Anything else (storage, sink or code errors) is a bug: it throws.
        if (isTransportFailure(error)) return fail('http_error', messageOf(error));
        throw error;
      }

      record.fetchId = response.provenance.fetchId;
      record.httpStatus = response.status;
      if (response.provenance.bodyPersisted) record.responseBlob = response.provenance.body;
      if (response.status >= 400) return fail('http_error', `HTTP ${response.status}`);

      type Envelope = {
        model?: unknown;
        usage?: unknown;
        choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      let parsed: unknown;
      try {
        parsed = response.json();
      } catch {
        return fail('invalid_json', 'the response is not JSON');
      }
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Envelope).choices)) {
        return fail('invalid_json', 'the response is not a chat completion object');
      }
      const envelope = parsed as Envelope;
      if (typeof envelope.model === 'string') record.modelReported = envelope.model;
      if (envelope.usage && typeof envelope.usage === 'object')
        record.usage = envelope.usage as Record<string, unknown>;
      const choice = envelope.choices?.[0];
      if (choice?.finish_reason === 'length') {
        return fail('invalid_json', 'the output was cut off (finish_reason length)');
      }
      const content = choice?.message?.content;
      if (typeof content !== 'string') return fail('invalid_json', 'the response has no message content');
      let value: unknown;
      try {
        value = JSON.parse(content.trim());
      } catch {
        return fail('invalid_json', 'the message content is not JSON');
      }
      let output: T;
      try {
        output = request.parseOutput(value);
      } catch (error) {
        // The raw output stays in the logged response blob.
        return fail('schema_violation', messageOf(error));
      }

      const finished = clock.now();
      await log.append({
        ...record,
        output,
        outcome: 'ok',
        finishedAt: finished.toISOString(),
        latencyMs: finished.getTime() - started.getTime(),
      });
      return {
        ok: true,
        output,
        callId,
        model: record.modelReported ?? config.model,
        ...(config.modelDigest ? { modelDigest: config.modelDigest } : {}),
      };
    },
  };
}
