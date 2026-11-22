/**
 * Model suggestions and the analyst's decision about them. A suggestion has zero score weight: deciding only records
 * the analyst's confirmation or rejection (append-only, once per suggestion, with a justification); it never changes
 * a stored score and takes effect only in a later rescore. The analyst is the API's configured identity.
 */
import type { LlmSuggestionDecision, Logger, Repositories, RunWithProgress } from '@olcys/core';
import { newId, nowIso, parse, SuggestionDecisionSchema } from '@olcys/core';
import type { FastifyInstance } from 'fastify';
import { idOf } from './ids.ts';

export interface SuggestionRouteDeps {
  repos: Repositories;
  analyst: string;
  logger?: Logger;
  /** Renders the run's report again (a new stored version); see `reportRenderer`. */
  renderReport?(run: RunWithProgress): Promise<void>;
}

export function registerSuggestionRoutes(app: FastifyInstance, deps: SuggestionRouteDeps): void {
  const llm = deps.repos.llm;
  if (!llm) return;

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/suggestions', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await deps.repos.runs.get(runId) : undefined;
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'run not found' });
    return { items: await llm.listSuggestionsByRun(run.id) };
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
    const run = await deps.repos.runs.get(suggestion.runId);
    if (deps.renderReport && run && (run.status === 'succeeded' || run.status === 'partial')) {
      void deps.renderReport(run).catch((error: unknown) =>
        deps.logger?.error('report not rendered after a suggestion decision', {
          runId: run.id,
          error: String(error),
        }),
      );
    }
    return await llm.getSuggestion(suggestion.id);
  });
}
