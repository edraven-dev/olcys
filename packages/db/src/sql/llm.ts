/**
 * Model calls and suggestions (append-only: the application role may only insert and read). A suggestion's status is
 * derived from its one decision row (`llm_suggestion_decision.suggestion_id` is unique).
 */
import type { LlmRepository, LlmSuggestion } from '@olcys/core';
import type { Selectable } from 'kysely';
import { iso, json, type Db } from '../client.ts';
import type { LlmSuggestionDecisionTable, LlmSuggestionTable } from '../schema.ts';

type DecisionRow = Pick<
  Selectable<LlmSuggestionDecisionTable>,
  'decision' | 'justification' | 'edited_text' | 'decided_by' | 'decided_at'
>;

function toSuggestion(row: Selectable<LlmSuggestionTable>, decision: Partial<DecisionRow>): LlmSuggestion {
  const suggestion: LlmSuggestion = {
    id: row.id,
    runId: row.run_id,
    task: row.task,
    target: row.target,
    label: row.label,
    model: row.model,
    promptVersion: row.prompt_version,
    callId: row.call_id,
    status: decision.decision ?? 'pending',
    createdAt: iso(row.created_at) ?? '',
  };
  if (row.rationale !== null) suggestion.rationale = row.rationale;
  if (row.output !== null) suggestion.output = row.output;
  if (row.model_digest !== null) suggestion.modelDigest = row.model_digest;
  if (decision.decision) {
    if (decision.decided_by) suggestion.decidedBy = decision.decided_by;
    const decidedAt = iso(decision.decided_at);
    if (decidedAt) suggestion.decidedAt = decidedAt;
    if (decision.justification) suggestion.justification = decision.justification;
    if (decision.edited_text) suggestion.editedText = decision.edited_text;
  }
  return suggestion;
}

export function sqlLlmRepository(db: Db): LlmRepository {
  const decisionOf = async (suggestionId: string): Promise<Partial<DecisionRow>> =>
    (await db
      .selectFrom('llm_suggestion_decision')
      .selectAll()
      .where('suggestion_id', '=', suggestionId)
      .executeTakeFirst()) ?? {};

  return {
    async addCall(r) {
      await db
        .insertInto('llm_call')
        .values({
          id: r.id,
          case_id: r.caseId ?? null,
          run_id: r.runId ?? null,
          task: r.task,
          prompt_version: r.promptVersion,
          prompt_sha256: r.promptSha256,
          base_url: r.baseUrl,
          model_requested: r.modelRequested,
          model_reported: r.modelReported ?? null,
          model_digest: r.modelDigest ?? null,
          params: json(r.params),
          request_sha256: r.requestSha256 ?? null,
          request_blob: r.requestBlob ? json(r.requestBlob) : null,
          input_sha256: r.inputSha256,
          input_capture_ids: r.inputCaptureIds,
          input_source_ids: r.inputSourceIds,
          response_blob: r.responseBlob ? json(r.responseBlob) : null,
          output_json: r.output === undefined ? null : json(r.output),
          outcome: r.outcome,
          error: r.error ?? null,
          http_status: r.httpStatus ?? null,
          latency_ms: r.latencyMs === undefined ? null : Math.round(r.latencyMs),
          usage: r.usage ? json(r.usage) : null,
          fetch_id: r.fetchId ?? null,
          started_at: r.startedAt,
          finished_at: r.finishedAt,
        })
        .execute();
    },

    async addSuggestions(suggestions) {
      if (suggestions.length === 0) return;
      await db
        .insertInto('llm_suggestion')
        .values(
          suggestions.map((s) => ({
            id: s.id,
            run_id: s.runId,
            task: s.task,
            target: json(s.target),
            label: s.label,
            rationale: s.rationale ?? null,
            output: s.output === undefined ? null : json(s.output),
            model: s.model,
            model_digest: s.modelDigest ?? null,
            prompt_version: s.promptVersion,
            call_id: s.callId,
            created_at: s.createdAt,
          })),
        )
        .execute();
    },

    async getSuggestion(id) {
      const row = await db.selectFrom('llm_suggestion').selectAll().where('id', '=', id).executeTakeFirst();
      return row ? toSuggestion(row, await decisionOf(id)) : undefined;
    },

    async listSuggestionsByRun(runId) {
      const rows = await db
        .selectFrom('llm_suggestion')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      if (rows.length === 0) return [];
      const decisions = await db
        .selectFrom('llm_suggestion_decision')
        .selectAll()
        .where(
          'suggestion_id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      const byId = new Map(decisions.map((d) => [d.suggestion_id, d]));
      return rows.map((row) => toSuggestion(row, byId.get(row.id) ?? {}));
    },

    async decide(d) {
      const inserted = await db
        .insertInto('llm_suggestion_decision')
        .values({
          id: d.id,
          suggestion_id: d.suggestionId,
          decision: d.decision,
          justification: d.justification,
          edited_text: d.editedText ?? null,
          decided_by: d.decidedBy,
          decided_at: d.decidedAt,
        })
        .onConflict((oc) => oc.column('suggestion_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
