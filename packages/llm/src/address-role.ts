/**
 * Asks the model to suggest the role of one address mention. Gates run before any call (model enabled, the source may
 * be shown to a model, enough text), the answer is checked afterwards: the evidence span must occur verbatim in the
 * scraped text of the input. The outcome is a suggestion with zero score weight; nothing here touches a score.
 */
import type {
  AddressCandidate,
  Capture,
  Id,
  LlmClient,
  LlmFailureCode,
  NewLlmSuggestion,
  RoleCue,
  SourceDescriptor,
} from '@olcys/core';
import { buildLlmRequest } from './prompts/registry.ts';
import { ADDRESS_ROLE_TASK, addressRolePromptV1, type AddressRoleOutput } from './prompts/address-role/v1.ts';
import { sanitizeUntrusted } from './untrusted.ts';

/** Shorter snippets carry no usable context. */
export const MIN_SNIPPET_CHARS = 20;
const SOURCE_TELEGRAM = 'telegram_preview';
const TELEGRAM_HOSTS = /(^|\.)(t\.me|telegram\.me|telegram\.org|telesco\.pe)$/i;

export interface RoleClassificationInput {
  candidate: Pick<AddressCandidate, 'id' | 'address' | 'context'>;
  capture: Pick<Capture, 'id' | 'sourceId' | 'url' | 'finalUrl' | 'archive'>;
  /** The register entry of the capture's source; an unknown source is not shown to the model. */
  source: Pick<SourceDescriptor, 'id' | 'llmAllowed'> | undefined;
  platform?: string;
  linkAssessmentId?: Id;
  runId: Id;
  caseId: Id;
}

export type RoleSkipReason = 'llm_disabled' | 'llm_not_allowed' | 'snippet_too_short';

export type RoleClassificationOutcome =
  | { status: 'suggested'; suggestion: Omit<NewLlmSuggestion, 'id' | 'createdAt'> }
  | { status: 'skipped'; reason: RoleSkipReason }
  | { status: 'failed'; reason: LlmFailureCode | 'span_not_in_input'; callId?: Id };

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Text from Telegram (the `telegram_preview` source, any capture of a Telegram host, an archived copy of one) never
 * reaches the model, and neither does a source whose register entry says `llmAllowed: false` or that is unknown.
 */
export function isLlmAllowed(
  capture: Pick<Capture, 'sourceId' | 'url' | 'finalUrl' | 'archive'>,
  source: Pick<SourceDescriptor, 'id' | 'llmAllowed'> | undefined,
): boolean {
  if (!source || source.llmAllowed === false) return false;
  if (capture.sourceId === SOURCE_TELEGRAM || source.id === SOURCE_TELEGRAM) return false;
  return ![capture.url, capture.finalUrl, capture.archive?.originalUrl].some((u) => {
    const host = hostOf(u);
    return host !== undefined && TELEGRAM_HOSTS.test(host);
  });
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The scraped text lines the model may quote (heading, label, snippet), with their prefixes. */
function scrapedLines(candidate: RoleClassificationInput['candidate']): {
  heading?: string;
  label?: string;
  snippet: string;
} {
  const { heading, label, snippet } = candidate.context;
  return {
    ...(heading ? { heading: oneLine(heading) } : {}),
    ...(label ? { label: oneLine(label) } : {}),
    snippet: oneLine(snippet),
  };
}

/** The text sent to the model (the client delimits it): short lines `adres:`, `sieć:`, `platforma:`, … `fragment:`. */
export function buildRoleInput(input: RoleClassificationInput): string {
  const { heading, label, snippet } = scrapedLines(input.candidate);
  const head = [
    `adres: ${input.candidate.address.address}`,
    `sieć: ${input.candidate.address.chain}`,
    ...(input.platform ? [`platforma: ${oneLine(input.platform)}`] : []),
    ...(heading ? [`nagłówek: ${heading}`] : []),
    ...(label ? [`etykieta: ${label}`] : []),
  ];
  const max = addressRolePromptV1.maxInputChars;
  const prefix = `${head.join('\n')}\nfragment: `;
  // The snippet is windowed around the address, not cut at its end, so the cue next to the address survives.
  let text = snippet;
  const room = Math.max(0, max - sanitizeUntrusted(prefix).length);
  if (text.length > room) {
    const at = Math.max(0, text.indexOf(input.candidate.address.address));
    const start = Math.min(Math.max(0, at - Math.floor(room / 2)), text.length - room);
    text = text.slice(start, start + room);
  }
  return `${prefix}${text}`;
}

/** True when `span` occurs verbatim (whitespace collapsed) in the scraped text the model was shown. */
export function spanInInput(span: string, sent: string): boolean {
  const wanted = oneLine(sanitizeUntrusted(span));
  if (wanted.length === 0) return false;
  const shown = sanitizeUntrusted(sent);
  // Only the scraped lines count: a span cannot be taken from the address, network or platform lines.
  const scraped = shown
    .split('\n')
    .filter((line) => /^(nagłówek|etykieta|fragment): /u.test(line))
    .map((line) => line.replace(/^[^:]+: /u, ''));
  return scraped.some((line) => line.includes(wanted));
}

export type AddressRoleSuggestion = Omit<NewLlmSuggestion, 'id' | 'createdAt'>;

export async function classifyAddressMention(
  input: RoleClassificationInput,
  deps: { llm: LlmClient },
): Promise<RoleClassificationOutcome> {
  if (!deps.llm.enabled) return { status: 'skipped', reason: 'llm_disabled' };
  if (!isLlmAllowed(input.capture, input.source)) return { status: 'skipped', reason: 'llm_not_allowed' };
  if (input.candidate.context.snippet.trim().length < MIN_SNIPPET_CHARS) {
    return { status: 'skipped', reason: 'snippet_too_short' };
  }
  const untrustedInput = buildRoleInput(input);
  const request = buildLlmRequest(addressRolePromptV1, {
    untrustedInput,
    inputs: [{ captureId: input.capture.id, sourceId: input.capture.sourceId, llmAllowed: true }],
    containsIdentifier: true,
    runId: input.runId,
    caseId: input.caseId,
  });
  const result = await deps.llm.complete<AddressRoleOutput>(request);
  if (!result.ok) return { status: 'failed', reason: result.code, callId: result.callId };
  if (!spanInInput(result.output.evidenceSpan, untrustedInput)) {
    return { status: 'failed', reason: 'span_not_in_input', callId: result.callId };
  }
  const lexiconCues: RoleCue[] = input.candidate.context.roleCues;
  return {
    status: 'suggested',
    suggestion: {
      runId: input.runId,
      task: ADDRESS_ROLE_TASK,
      target: {
        candidateId: input.candidate.id,
        ...(input.linkAssessmentId ? { linkAssessmentId: input.linkAssessmentId } : {}),
      },
      label: result.output.role,
      rationale: result.output.rationale,
      output: { ...result.output, agreement: lexiconAgreement(result.output.role, lexiconCues), lexiconCues },
      model: result.model,
      ...(result.modelDigest ? { modelDigest: result.modelDigest } : {}),
      promptVersion: addressRolePromptV1.version,
      callId: result.callId,
    },
  };
}

/** Does the lexicon (deterministic cues) agree with the model's role? Silent when it has no usable cue. */
export function lexiconAgreement(
  role: RoleCue,
  lexiconCues: readonly RoleCue[],
): 'agrees' | 'differs' | 'lexicon_silent' {
  const cues = lexiconCues.filter((c) => c !== 'unclear');
  if (cues.length === 0) return 'lexicon_silent';
  return cues.includes(role) ? 'agrees' : 'differs';
}
