/**
 * New-case form model: validation that mirrors the API's `CreateCaseSchema` plus the source-register rules the
 * console enforces (RED is never sent, AMBER needs a justification of at least 20 characters), and the request body.
 */
import type { ChainId, CreateCaseInput, IdentifierKind } from '@olcys/core';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { DEFAULT_CHAINS } from '../../lib/chains.ts';
import type { SourceItem } from '../../lib/domain.ts';

export const MIN_JUSTIFICATION = 20;

export interface IdentifierRow {
  rowId: string;
  kind: IdentifierKind;
  value: string;
  platform: string;
  chain: string;
  isAnchor: boolean;
}

export interface CaseFormState {
  title: string;
  purpose: string;
  legalBasis: string;
  identifiers: IdentifierRow[];
  enabled: Record<string, boolean>;
  justifications: Record<string, string>;
  chains: string[];
  maxPivotDepth: number;
  minimisation: boolean;
}

/** Field path → Polish message. Paths: `title`, `identifiers`, `identifiers.0.value`, `source.<id>`, … */
export type FormErrors = Record<string, string>;

let rowCounter = 0;
export function newIdentifierRow(kind: IdentifierKind = 'nickname'): IdentifierRow {
  rowCounter += 1;
  return { rowId: `row-${rowCounter}`, kind, value: '', platform: '', chain: '', isAnchor: false };
}

export function initialFormState(sources: readonly SourceItem[] = []): CaseFormState {
  return {
    title: '',
    purpose: '',
    legalBasis: '',
    identifiers: [newIdentifierRow('full_name')],
    enabled: Object.fromEntries(
      sources.filter((s) => s.compliance === 'GREEN' && s.enabledByDefault).map((s) => [s.id, true]),
    ),
    justifications: {},
    chains: [...DEFAULT_CHAINS],
    maxPivotDepth: 2,
    minimisation: false,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function lengthError(value: string, min: number, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return pl.errors.required;
  if (trimmed.length < min) return t(pl.errors.too_short, { min });
  if (trimmed.length > max) return t(pl.errors.too_long, { max });
  return undefined;
}

/** Sources that will be sent: enabled, known and never RED. */
export function enabledSourceIds(state: CaseFormState, sources: readonly SourceItem[]): string[] {
  return sources.filter((s) => s.compliance !== 'RED' && state.enabled[s.id]).map((s) => s.id);
}

export function validateCaseForm(state: CaseFormState, sources: readonly SourceItem[]): FormErrors {
  const errors: FormErrors = {};
  const set = (path: string, message: string | undefined) => {
    if (message) errors[path] = message;
  };
  set('title', lengthError(state.title, 3, 200));
  set('purpose', lengthError(state.purpose, 10, 2000));
  set('legalBasis', lengthError(state.legalBasis, 3, 500));
  if (state.identifiers.length === 0) set('identifiers', pl.errors.identifiers_required);
  state.identifiers.forEach((row, index) => {
    const value = row.value.trim();
    if (!value) set(`identifiers.${index}.value`, pl.errors.required);
    else if (value.length > 512) set(`identifiers.${index}.value`, t(pl.errors.too_long, { max: 512 }));
    else if (row.kind === 'email' && !EMAIL.test(value)) set(`identifiers.${index}.value`, pl.errors.invalid_email);
    if (row.platform.trim().length > 64) set(`identifiers.${index}.platform`, t(pl.errors.too_long, { max: 64 }));
    if (row.kind === 'crypto_address' && !row.chain) set(`identifiers.${index}.chain`, pl.errors.chain_required);
  });
  for (const source of sources) {
    if (!state.enabled[source.id]) continue;
    if (source.compliance === 'RED') set(`source.${source.id}`, pl.errors.source_forbidden);
    if (source.compliance === 'AMBER') {
      const text = (state.justifications[source.id] ?? '').trim();
      if (!text) set(`source.${source.id}`, pl.errors.amber_justification_required);
      else if (text.length < MIN_JUSTIFICATION)
        set(`source.${source.id}`, t(pl.errors.justification_too_short, { min: MIN_JUSTIFICATION }));
    }
  }
  if (sources.length > 0 && enabledSourceIds(state, sources).length === 0) set('sources', pl.errors.sources_required);
  if (!state.minimisation) set('minimisation', pl.errors.minimisation_required);
  return errors;
}

/** Body of `POST /api/cases` (strict schema: optional fields are omitted, never sent empty). */
export function buildCreateCaseRequest(state: CaseFormState, sources: readonly SourceItem[]): CreateCaseInput {
  const enabledSources = enabledSourceIds(state, sources);
  const amberJustifications: Record<string, string> = {};
  for (const source of sources) {
    if (source.compliance === 'AMBER' && enabledSources.includes(source.id)) {
      amberJustifications[source.id] = (state.justifications[source.id] ?? '').trim();
    }
  }
  return {
    title: state.title.trim(),
    purpose: state.purpose.trim(),
    legalBasis: state.legalBasis.trim(),
    identifiers: state.identifiers.map((row) => {
      const platform = row.platform.trim();
      return {
        kind: row.kind,
        value: row.value.trim(),
        ...(platform ? { platform } : {}),
        ...(row.kind === 'crypto_address' && row.chain ? { chain: row.chain as ChainId } : {}),
        isAnchor: row.isAnchor,
      };
    }),
    scope: {
      enabledSources,
      amberJustifications,
      chains: state.chains as ChainId[],
      maxPivotDepth: state.maxPivotDepth,
    },
  };
}

export interface SubmitClient {
  createCase(body: CreateCaseInput): Promise<{ id: string }>;
  startRun(caseId: string): Promise<{ id: string }>;
}

export interface SubmitOutcome {
  /** Set as soon as the case exists — also when starting the run failed, so a retry never creates a second case. */
  caseId?: string;
  runId?: string;
  error?: unknown;
}

/**
 * Creates the case (unless `existingCaseId` says it was already created) and optionally starts its first run.
 * Never throws: the outcome keeps the case id next to the error of a failed run start.
 */
export async function submitCase(
  body: CreateCaseInput,
  startRun: boolean,
  existingCaseId: string | undefined,
  client: SubmitClient,
): Promise<SubmitOutcome> {
  let caseId = existingCaseId;
  try {
    caseId ??= (await client.createCase(body)).id;
    if (!startRun) return { caseId };
    return { caseId, runId: (await client.startRun(caseId)).id };
  } catch (error) {
    return caseId ? { caseId, error } : { error };
  }
}

/** Maps API validation issues (`identifiers.0.value`, `scope.amberJustifications.github`) onto form fields. */
export function errorsFromIssues(issues: readonly { path: string; message: string }[]): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const amber = /^scope\.amberJustifications\.(.+)$/.exec(issue.path);
    const field = amber ? `source.${amber[1]}` : issue.path || 'form';
    // The server's English message is never shown; the field path is enough to locate the problem.
    errors[field] ??= t(pl.errors.fieldIssue, { path: issue.path || '-' });
  }
  return errors;
}
