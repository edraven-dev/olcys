/**
 * Analyst judgements and overrides. A judgement is a statement recorded next to a computed link assessment, never
 * instead of it: it changes no score, gate or change event. An override is an input to the evidence of a case that
 * only a later rescore run applies, producing a new assessment. Both are append-only and logged (analyst and ids,
 * never free text). The analyst is the API's configured identity, never a field of the request.
 */
import type {
  AddressRef,
  AnalystJudgement,
  AnalystOverride,
  AnalystOverrideTarget,
  CreateOverrideInput,
  Id,
  LinkAssessment,
  Logger,
  Repositories,
  RunWithProgress,
  SourceDescriptor,
} from '@olcys/core';
import {
  ADD_EVIDENCE_FEATURES,
  ADD_EVIDENCE_HOPS,
  addressKey,
  CreateJudgementSchema,
  CreateOverrideSchema,
  JUSTIFICATION_LENGTH,
  newId,
  nowIso,
  parse,
  REVIEW_DECISIONS,
  type AddEvidenceFeature,
} from '@olcys/core';
import { evidenceRunIdOf } from '@olcys/worker';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { idOf } from './ids.ts';

export interface AnalystRouteDeps {
  repos: Repositories;
  sources: readonly SourceDescriptor[];
  /** Recorded as the author of every judgement and override. */
  analyst: string;
  logger?: Logger;
  /** Renders a new version of a finished run's report, which then shows the judgements recorded so far. */
  renderReport?(run: RunWithProgress): Promise<void>;
}

/** The analyst name when the configuration names none. */
export const DEFAULT_ANALYST = 'analyst';

/**
 * The analyst identity until authentication exists, for every analyst action (cases, schedule changes, judgements,
 * overrides): `OLCYS_ANALYST_NAME`, else `OLCYS_COLLECTOR_NAME`, else `analyst`.
 */
export function analystName(env: Readonly<Record<string, string | undefined>>): string {
  return env['OLCYS_ANALYST_NAME']?.trim() || env['OLCYS_COLLECTOR_NAME']?.trim() || DEFAULT_ANALYST;
}

/** Judgements and overrides need both stores and the lookup of a link by id. */
export function supportsJudgements(repos: Repositories): boolean {
  return Boolean(repos.judgements && repos.overrides && repos.analysis.getLink);
}

/** The links of a run, each with its judgements (oldest first). The assessments are returned as stored. */
export async function withJudgements(
  repos: Repositories,
  runId: Id,
  links: LinkAssessment[],
): Promise<(LinkAssessment & { judgements?: AnalystJudgement[] })[]> {
  if (!repos.judgements) return links;
  const judgements = await repos.judgements.listByRun(runId);
  return links.map((link) => ({ ...link, judgements: judgements.filter((j) => j.linkAssessmentId === link.id) }));
}

export interface Problem {
  code: string;
  message: string;
}

export function justificationProblem(text: string): Problem | undefined {
  const { min, max } = JUSTIFICATION_LENGTH;
  if (text.length < min) return { code: 'justification_too_short', message: `justification needs ${min}+ characters` };
  if (text.length > max) return { code: 'justification_too_long', message: `justification allows ${max} characters` };
  return undefined;
}

const GRADES: ReadonlySet<string> = new Set(['A', 'B', 'C', 'D', 'E']);
const invalidTarget = (message: string): Problem => ({ code: 'invalid_target', message });
const isFeature = (value: string): value is AddEvidenceFeature =>
  (ADD_EVIDENCE_FEATURES as readonly string[]).includes(value);

/** The value and the target fields the kind of an override requires (that the target exists is checked apart). */
export function overrideProblem(input: Pick<CreateOverrideInput, 'kind' | 'value' | 'target'>): Problem | undefined {
  const { target } = input;
  const given = (Object.keys(target) as (keyof AnalystOverrideTarget)[]).filter((k) => target[k] !== undefined);
  const only = (...allowed: (keyof AnalystOverrideTarget)[]): boolean => given.every((k) => allowed.includes(k));
  switch (input.kind) {
    case 'reliability_grade':
      if (input.value === 'F') {
        return { code: 'grade_not_allowed', message: 'grade F means "cannot be judged" and cannot be set' };
      }
      if (!GRADES.has(input.value)) return { code: 'invalid_value', message: 'a grade is one of A, B, C, D, E' };
      if (given.length !== 1 || !only('observationId', 'candidateId', 'sourceId')) {
        return invalidTarget('a grade names exactly one observation, candidate or source');
      }
      return undefined;
    case 'review_decision':
      if (!(REVIEW_DECISIONS as readonly string[]).includes(input.value)) {
        return { code: 'invalid_value', message: `a review decision is one of ${REVIEW_DECISIONS.join(', ')}` };
      }
      if (!target.candidateId || !only('candidateId')) return invalidTarget('a review decision names one candidate');
      return undefined;
    case 'add_evidence': {
      if (!isFeature(input.value)) {
        return {
          code: 'feature_not_allowed',
          message: `analyst evidence is one of ${ADD_EVIDENCE_FEATURES.join(', ')}`,
        };
      }
      const address = ADD_EVIDENCE_HOPS[input.value] === 'address';
      if (!target.accountId || (address && !target.address)) {
        return invalidTarget(
          address ? 'this evidence names an account and an address' : 'this evidence names an account',
        );
      }
      if (!only('accountId', ...(address ? (['address'] as const) : []))) {
        return invalidTarget('unexpected target fields for this evidence');
      }
      return undefined;
    }
  }
}

/** Canonical form of an address for comparisons (EVM addresses are case-insensitive). */
const canonicalRef = (ref: AddressRef): AddressRef =>
  ref.chain.startsWith('evm:') ? { chain: ref.chain, address: ref.address.toLowerCase() } : ref;

function canonicalTarget(target: CreateOverrideInput['target']): AnalystOverrideTarget {
  return {
    ...(target.sourceId ? { sourceId: target.sourceId } : {}),
    ...(target.observationId ? { observationId: target.observationId.toLowerCase() } : {}),
    ...(target.candidateId ? { candidateId: target.candidateId.toLowerCase() } : {}),
    ...(target.accountId ? { accountId: target.accountId.toLowerCase() } : {}),
    ...(target.address ? { address: canonicalRef(target.address) } : {}),
  };
}

/** Every item of `load` over `ids`. */
const all = async <T>(ids: readonly Id[], load: (id: Id) => Promise<T[]>): Promise<T[]> =>
  (await Promise.all(ids.map(load))).flat();
const missing = (what: string): Problem => ({
  code: 'target_not_found',
  message: `${what} is not in a run of this case`,
});

/** The target must belong to a run of the case (evidence as collected, candidates and links as assessed). */
async function targetProblem(
  deps: AnalystRouteDeps,
  caseId: Id,
  kind: AnalystOverride['kind'],
  target: AnalystOverrideTarget,
): Promise<Problem | undefined> {
  const { repos } = deps;
  const runs = await repos.runs.listByCase(caseId);
  const runIds = runs.map((r) => r.id);
  const evidenceRunIds = [...new Set(runs.map((r) => evidenceRunIdOf(r)))];

  if (target.observationId) {
    const observations = await all(evidenceRunIds, (id) => repos.evidence.listObservations(id));
    if (!observations.some((o) => o.id === target.observationId)) return missing('the observation');
  }
  if (target.candidateId) {
    const candidates = await all(runIds, (id) => repos.evidence.listCandidates(id));
    const candidate = candidates.find((c) => c.id === target.candidateId);
    if (!candidate) return missing('the candidate');
    if (kind === 'review_decision' && !candidate.reviewRequired) {
      return {
        code: 'candidate_not_review_required',
        message: 'only a deobfuscated, gap-joined or OCR-repaired match awaits a review decision',
      };
    }
  }
  if (target.sourceId) {
    if (!deps.sources.some((s) => s.id === target.sourceId)) return missing('the source');
    const [captures, observations] = await Promise.all([
      all(evidenceRunIds, (id) => repos.evidence.listCaptures(id)),
      all(evidenceRunIds, (id) => repos.evidence.listObservations(id)),
    ]);
    if (![...captures, ...observations].some((x) => x.sourceId === target.sourceId)) return missing('the source');
  }
  if (target.accountId) {
    const accounts = await all(evidenceRunIds, (id) => repos.evidence.listAccounts(id));
    if (!accounts.some((a) => a.id === target.accountId)) return missing('the account');
  }
  if (target.address) {
    const key = addressKey(target.address);
    const links = await all(runIds, (id) => repos.analysis.listLinks(id));
    if (!links.some((l) => addressKey(canonicalRef(l.address)) === key)) return missing('a link with the address');
  }
  return undefined;
}

const unprocessable = (reply: FastifyReply, problem: Problem) =>
  reply.code(422).send({ error: problem.code, message: problem.message });
const linkNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'link_not_found', message: 'link not found' });
const caseNotFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'case not found' });

/** Registers the judgement, override and report re-rendering routes when the store supports them. */
export function registerAnalystRoutes(app: FastifyInstance, deps: AnalystRouteDeps): void {
  const { repos, logger } = deps;
  const judgements = repos.judgements;
  const overrides = repos.overrides;
  const getLink = repos.analysis.getLink?.bind(repos.analysis);
  if (!judgements || !overrides || !getLink) return;

  const findLink = async (raw: string): Promise<LinkAssessment | undefined> => {
    const id = idOf(raw);
    return id ? getLink(id) : undefined;
  };
  const findCase = async (raw: string) => {
    const id = idOf(raw);
    return id ? repos.cases.get(id) : undefined;
  };

  app.get<{ Params: { linkId: string } }>('/api/links/:linkId/judgements', async (request, reply) => {
    const link = await findLink(request.params.linkId);
    if (!link) return linkNotFound(reply);
    return { items: await judgements.listByLink(link.id) };
  });

  app.post<{ Params: { linkId: string } }>('/api/links/:linkId/judgements', async (request, reply) => {
    const link = await findLink(request.params.linkId);
    if (!link) return linkNotFound(reply);
    const input = parse(CreateJudgementSchema, request.body ?? {});
    const justification = input.justification.trim();
    const problem = justificationProblem(justification);
    if (problem) return unprocessable(reply, problem);
    const judgement: AnalystJudgement = {
      id: newId(),
      linkAssessmentId: link.id,
      judgement: input.judgement,
      justification,
      analyst: deps.analyst,
      at: nowIso(),
    };
    await judgements.add(judgement);
    logger?.info('analyst judgement recorded', {
      judgementId: judgement.id,
      linkId: link.id,
      runId: link.runId,
      judgement: judgement.judgement,
      analyst: judgement.analyst,
    });
    return reply.code(201).send(judgement);
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/overrides', async (request, reply) => {
    const kase = await findCase(request.params.caseId);
    if (!kase) return caseNotFound(reply);
    return { items: await overrides.listByCase(kase.id) };
  });

  app.post<{ Params: { caseId: string } }>('/api/cases/:caseId/overrides', async (request, reply) => {
    const kase = await findCase(request.params.caseId);
    if (!kase) return caseNotFound(reply);
    const input = parse(CreateOverrideSchema, request.body ?? {});
    const justification = input.justification.trim();
    const shape = justificationProblem(justification) ?? overrideProblem(input);
    if (shape) return unprocessable(reply, shape);
    const target = canonicalTarget(input.target);
    const unknown = await targetProblem(deps, kase.id, input.kind, target);
    if (unknown) return unprocessable(reply, unknown);
    const override: AnalystOverride = {
      id: newId(),
      caseId: kase.id,
      kind: input.kind,
      target,
      value: input.value,
      justification,
      analyst: deps.analyst,
      at: nowIso(),
    };
    await overrides.add(override);
    logger?.info('analyst override recorded', {
      overrideId: override.id,
      caseId: kase.id,
      kind: override.kind,
      value: override.value,
      target: Object.keys(target).join(','),
      analyst: override.analyst,
    });
    return reply.code(201).send(override);
  });

  const render = deps.renderReport;
  if (render) {
    // The stored report is a fixed document: rendering again adds a new version with the judgements made since.
    app.post<{ Params: { runId: string } }>('/api/runs/:runId/report', async (request, reply) => {
      const runId = idOf(request.params.runId);
      const run = runId ? await repos.runs.get(runId) : undefined;
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'run not found' });
      if (run.status !== 'succeeded' && run.status !== 'partial') {
        return reply.code(409).send({ error: 'run_not_finished', message: 'only a finished run has a report' });
      }
      await render(run);
      const report = await repos.analysis.latestReport(run.id, 'html');
      logger?.info('report rendered again', { runId: run.id, analyst: deps.analyst });
      return reply.code(201).send({ runId: run.id, ...report });
    });
  }
}
