/**
 * Pipeline step `llm.suggest`: asks the local model for the role of address mentions (owner, payment request, scam
 * report, ...) and stores the answers as pending suggestions. The model only suggests: nothing here writes a score or
 * an evidence feature, the suggestions weigh zero until an analyst confirms them and only a later rescore may use a
 * confirmed one. A missing, failing or slow model never fails the run: it is recorded as a partial reason and the run
 * goes on. Telegram text is never sent (see `isLlmAllowed`).
 */
import type { AddressCandidate, Id, LlmClient, NewLlmSuggestion, SourceDescriptor } from '@olcys/core';
import { addressKey, newId, nowIso } from '@olcys/core';
import { classifyAddressMention } from '@olcys/llm';
import type { Stage, StageContext } from './pipeline.ts';

/** Mentions classified per run when `LLM_MAX_MENTIONS_PER_RUN` is not set. */
export const DEFAULT_MAX_MENTIONS = 20;
/** After this many model failures in a row the model counts as unreachable and the step stops calling it. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Failures of the model service (not of one answer): they are what "unreachable" is made of. */
const SERVICE_FAILURES: ReadonlySet<string> = new Set(['timeout', 'http_error', 'egress_denied', 'disabled']);

export interface SuggestRolesOptions {
  sources: readonly SourceDescriptor[];
  llm: LlmClient;
  /** Upper bound of model calls per run. */
  maxMentions?: number;
}

/** `LLM_MAX_MENTIONS_PER_RUN` as a positive integer; anything else gives the default. */
export function maxMentionsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const n = Number(env['LLM_MAX_MENTIONS_PER_RUN']?.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_MENTIONS;
}

export function createSuggestRolesStage(options: SuggestRolesOptions): Stage {
  const byId = new Map(options.sources.map((s) => [s.id, s]));
  const limit = options.maxMentions ?? DEFAULT_MAX_MENTIONS;
  return {
    step: 'llm.suggest',
    async run(ctx: StageContext) {
      const store = ctx.repos.llm;
      // A rescore re-analyses saved evidence: the suggestions of the original run stay as they are.
      if (!options.llm.enabled || !store || ctx.run.trigger === 'rescore') return;

      const [candidates, captures, links, exclusions, existing] = await Promise.all([
        ctx.repos.evidence.listCandidates(ctx.run.id),
        ctx.repos.evidence.listCaptures(ctx.evidenceRunId),
        ctx.repos.analysis.listLinks(ctx.run.id),
        ctx.repos.analysis.listExclusions(ctx.evidenceRunId),
        store.listSuggestionsByRun(ctx.run.id),
      ]);
      const captureById = new Map(captures.map((c) => [c.id, c]));
      const done = new Set(existing.map((s) => s.target.candidateId));
      const linkByAddress = new Map<string, Id>();
      for (const l of links) linkByAddress.set(addressKey(l.address), l.id);
      const cited = new Set([...linkByAddress.keys(), ...exclusions.map((e) => addressKey(e.address))]);

      // Telegram-sourced captures are dropped before counting, so they never use up the bound; mentions of addresses
      // the analysis cites come first, then the rest in extraction order.
      const eligible = candidates.filter((c) => !done.has(c.id) && captureById.has(c.captureId));
      const ordered: AddressCandidate[] = [
        ...eligible.filter((c) => cited.has(addressKey(c.address))),
        ...eligible.filter((c) => !cited.has(addressKey(c.address))),
      ];

      const found: NewLlmSuggestion[] = [];
      const counts = { sent: 0, skipped: 0, rejected: 0, failed: 0, notReached: 0, overLimit: 0 };
      let consecutive = 0;
      let unreachable = false;
      for (const candidate of ordered) {
        const capture = captureById.get(candidate.captureId);
        if (!capture) continue;
        if (unreachable) {
          counts.notReached += 1;
          continue;
        }
        if (counts.sent >= limit) {
          counts.overLimit += 1;
          continue;
        }
        let outcome;
        try {
          // Sequential on purpose: one local model, one request at a time.
          // oxlint-disable-next-line no-await-in-loop
          outcome = await classifyAddressMention(
            {
              candidate,
              capture,
              source: byId.get(capture.sourceId),
              platform: capture.sourceId,
              ...(linkByAddress.get(addressKey(candidate.address))
                ? { linkAssessmentId: linkByAddress.get(addressKey(candidate.address)) as Id }
                : {}),
              runId: ctx.run.id,
              caseId: ctx.case.id,
            },
            { llm: options.llm },
          );
        } catch (error) {
          // A bug in the step must not take the analysis down with it: recorded like an unreachable model.
          ctx.logger.error('role suggestion failed unexpectedly', { runId: ctx.run.id, error: String(error) });
          outcome = { status: 'failed' as const, reason: 'http_error' as const };
        }
        if (outcome.status === 'skipped') {
          counts.skipped += 1;
          continue;
        }
        counts.sent += 1;
        if (outcome.status === 'suggested') {
          consecutive = 0;
          found.push({ ...outcome.suggestion, id: newId(), createdAt: nowIso() });
        } else if (SERVICE_FAILURES.has(outcome.reason)) {
          counts.failed += 1;
          consecutive += 1;
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) unreachable = true;
        } else {
          // The model answered, but not usably (invalid JSON, schema violation, a span that is not in the text).
          consecutive = 0;
          counts.rejected += 1;
        }
      }
      if (found.length) await store.addSuggestions(found);

      const unserved = counts.failed + counts.notReached;
      if (unserved > 0) {
        ctx.markPartial(
          `AI model unavailable or failing: no role suggestions for ${unserved} address mention(s); scores are unaffected`,
          { code: 'llm_unavailable', params: { count: unserved } },
        );
      }
      // Counts only: no scraped text or address goes to the log.
      ctx.logger.info('role suggestions finished', { runId: ctx.run.id, suggestions: found.length, ...counts });
      await ctx.progress({
        suggestions: found.length,
        suggestionsRejected: counts.rejected,
        suggestionsSkipped: counts.skipped + counts.overLimit,
      });
    },
  };
}
