/**
 * Model suggestions and the analyst's decision about them. A suggestion has zero score weight: deciding only records
 * the analyst's confirmation or rejection (append-only, once per suggestion, with a justification); it never changes
 * a stored score and takes effect only in a later rescore. The analyst is the API's configured identity.
 */
import type { DraftInferencesResult, LlmSuggestionDecision, Logger, Repositories, RunWithProgress } from '@olcys/core';
import { newId, nowIso, parse, SuggestionDecisionSchema } from '@olcys/core';
import type { FastifyInstance } from 'fastify';
import { idOf } from './ids.ts';

export interface SuggestionRouteDeps {
  repos: Repositories;
  analyst: string;
  logger?: Logger;
  /** Renders the run's report again (a new stored version); see `reportRenderer`. */
  renderReport?(run: RunWithProgress): Promise<void>;
  /** Whether the AI model is enabled; drafts of section C are offered only then. */
  llmEnabled?: boolean;
  /** Drafts inferences for section C of the run's report (suggestions only); see `createDraftInferencer`. */
  draftInferences?(run: RunWithProgress): Promise<DraftInferencesResult>;
}

export function registerSuggestionRoutes(app: FastifyInstance, deps: SuggestionRouteDeps): void {
  const llm = deps.repos.llm;
  if (!llm) return;

  // Renders of one run never overlap, so an older render cannot be stored after a newer one; renders requested while
  // one is running are coalesced into a single follow-up that reads every decision made so far.
  const renders = new Map<string, { again: boolean }>();
  const scheduleRender = (runId: string): void => {
    const active = renders.get(runId);
    if (active) {
      active.again = true;
      return;
    }
    const state = { again: false };
    renders.set(runId, state);
    void (async () => {
      try {
        do {
          state.again = false;
          // Sequential on purpose: one render of a run at a time.
          // oxlint-disable-next-line no-await-in-loop
          const run = await deps.repos.runs.get(runId);
          if (!run || (run.status !== 'succeeded' && run.status !== 'partial')) return;
          // oxlint-disable-next-line no-await-in-loop
          await deps
            .renderReport?.(run)
            .catch((error: unknown) =>
              deps.logger?.error('report not rendered after a suggestion decision', { runId, error: String(error) }),
            );
        } while (state.again);
      } finally {
        renders.delete(runId);
      }
    })();
  };

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/suggestions', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await deps.repos.runs.get(runId) : undefined;
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'run not found' });
    return { items: await llm.listSuggestionsByRun(run.id) };
  });

  // Explicit, analyst-triggered and bounded: one model call, a handful of drafts. A model failure is a typed result
  // (200 with `status: 'failed'`), never an error; the drafts are pending suggestions and change nothing else.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/report/drafts', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await deps.repos.runs.get(runId) : undefined;
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'run not found' });
    if (!deps.llmEnabled || !deps.draftInferences) {
      return reply.code(409).send({ error: 'llm_disabled', message: 'the AI model is not enabled' });
    }
    const result = await deps.draftInferences(run);
    deps.logger?.info('inference drafts requested', { runId: run.id, analyst: deps.analyst, status: result.status });
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/suggestions/:id/decision', async (request, reply) => {
    const id = idOf(request.params.id);
    const suggestion = id ? await llm.getSuggestion(id) : undefined;
    if (!suggestion) return reply.code(404).send({ error: 'not_found', message: 'suggestion not found' });
    const input = parse(SuggestionDecisionSchema, request.body ?? {});
    const decision: LlmSuggestionDecision = {
      id: newId(),
      suggestionId: suggestion.id,
      decision: input.decision,
      justification: input.justification,
      ...(input.editedText ? { editedText: input.editedText } : {}),
      decidedBy: deps.analyst,
      decidedAt: nowIso(),
    };
    if (!(await llm.decide(decision))) {
      return reply.code(409).send({ error: 'already_decided', message: 'the suggestion already has a decision' });
    }
    deps.logger?.info('suggestion decided', {
      suggestionId: suggestion.id,
      runId: suggestion.runId,
      decision: decision.decision,
      analyst: decision.decidedBy,
    });
    // The stored report is a fixed document: a decision adds a new version that shows it. The response does not wait
    // for the rendering (it can be slow); a failure is logged and the earlier versions stay.
    if (deps.renderReport) scheduleRender(suggestion.runId);
    return await llm.getSuggestion(suggestion.id);
  });
}
