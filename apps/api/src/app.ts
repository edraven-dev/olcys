/**
 * HTTP API for the analyst console. Reads the append-only store through the repository ports; starting a run hands
 * it to the pipeline (in-process in the MVP). Inputs are validated with the `@olcys/core` schemas.
 */
import type {
  ApiMeta,
  BlobStore,
  FetchMode,
  Logger,
  Repositories,
  RunConfigSnapshot,
  RunWithProgress,
  SourceDescriptor,
} from '@olcys/core';
import { ContractError, CORE_CONTRACTS_VERSION, CreateCaseSchema, parse, StartRunSchema } from '@olcys/core';
import { evidenceRunIdOf, TOOL_VERSION } from '@olcys/worker';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { DEFAULT_ANALYST, registerAnalystRoutes, supportsJudgements, withJudgements } from './analyst-routes.ts';
import { idOf } from './ids.ts';
import { registerScheduleRoutes } from './schedule-routes.ts';

export interface ApiDeps {
  repos: Repositories;
  blobs: BlobStore;
  sources: readonly SourceDescriptor[];
  /** Creates a run for the case and starts the pipeline without waiting for it. */
  startRun(
    caseId: string,
    input: { trigger?: 'manual' | 'rescore'; rescoreOfRunId?: string },
  ): Promise<RunWithProgress>;
  /**
   * Who acts — the one local analyst of the MVP (`analystName()`: `OLCYS_ANALYST_NAME`, else `OLCYS_COLLECTOR_NAME`,
   * else `analyst`): creates cases, changes schedules, records judgements and overrides. Never taken from a request.
   */
  analyst?: string;
  /** Fastify request logging. */
  httpLog?: boolean;
  /**
   * Fetch mode of the runs: shown by `GET /api/meta`; in live mode schedules keep the minimum interval (the strict
   * rule when absent).
   */
  mode?: FetchMode;
  /** Configuration snapshot of new runs, for `GET /api/meta`. */
  config?: { snapshot: RunConfigSnapshot };
  /** Audit log of analyst actions (judgements, overrides). */
  logger?: Logger;
  /** Renders a new version of a finished run's report (`POST /api/runs/:runId/report`). */
  renderReport?(run: RunWithProgress): Promise<void>;
  /** Periodic re-runs: live-mode minimum interval (default 60 min), who changes schedules (default: `analyst`), clock. */
  schedule?: { minIntervalMinutes?: number; analyst?: string; clock?: () => Date };
}

const notFound = (reply: FastifyReply, what: string) =>
  reply.code(404).send({ error: 'not_found', message: `${what} not found` });

/** Minimum length of an AMBER justification (matches the collectors' scope lock). */
export const MIN_AMBER_JUSTIFICATION = 20;

/**
 * Server-side scope check (the console checks the same): RED sources are never enabled, AMBER sources need a
 * justification, unknown source ids are refused. The collectors refuse the same again at collection time.
 */
export function scopeProblems(
  scope: { enabledSources: readonly string[]; amberJustifications: Readonly<Record<string, string>> },
  sources: readonly SourceDescriptor[],
): string[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const problems: string[] = [];
  for (const id of scope.enabledSources) {
    const source = byId.get(id);
    if (!source) problems.push(`unknown source ${id}`);
    else if (source.compliance === 'RED') problems.push(`source ${id} is RED and can never be enabled`);
    else if (
      source.compliance === 'AMBER' &&
      (scope.amberJustifications[id] ?? '').trim().length < MIN_AMBER_JUSTIFICATION
    ) {
      problems.push(
        `source ${id} is AMBER and needs a justification of at least ${MIN_AMBER_JUSTIFICATION} characters`,
      );
    }
  }
  return problems;
}

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: deps.httpLog ?? false });
  const { repos } = deps;
  const analyst = deps.analyst ?? DEFAULT_ANALYST;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ContractError) {
      return reply.code(400).send({ error: 'invalid_input', message: error.message, issues: error.issues });
    }
    // Fastify's own client errors (malformed JSON, unsupported media type, body too large) keep their status.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: 'bad_request', message: error instanceof Error ? error.message : 'bad request' });
    }
    app.log.error(error);
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  app.get('/api/health', async () => ({ status: 'ok', service: '@olcys/api', contracts: CORE_CONTRACTS_VERSION }));

  app.get('/api/meta', async (): Promise<ApiMeta> => {
    const snapshot = deps.config?.snapshot;
    return {
      toolVersion: snapshot?.toolVersion ?? TOOL_VERSION,
      contracts: CORE_CONTRACTS_VERSION,
      mode: deps.mode ?? 'offline',
      features: {
        judgements: supportsJudgements(repos),
        suggestions: false,
        schedules: repos.schedules !== undefined,
        reportPdf: false,
        exports: false,
        auth: false,
      },
      ...(snapshot
        ? {
            scoring: {
              weightsVersion: snapshot.weightsVersion,
              weightsSha256: snapshot.weightsSha256,
              rulesVersions: snapshot.rulesVersions,
            },
          }
        : {}),
    };
  });

  app.get('/api/sources', async () => ({
    items: deps.sources.map((s) => ({
      id: s.id,
      name: s.namePl ?? s.name,
      kind: s.kind,
      compliance: s.compliance,
      complianceNote: s.complianceNotePl ?? s.complianceNote,
      enabledByDefault: s.enabledByDefault,
      sendsIdentifiersExternally: s.sendsIdentifiersExternally,
      reliability: s.reliability,
      tosUrl: s.tosUrl ?? null,
    })),
  }));

  app.get('/api/cases', async () => ({ items: await repos.cases.list() }));

  app.post('/api/cases', async (request, reply) => {
    const input = parse(CreateCaseSchema, request.body);
    const problems = scopeProblems(input.scope, deps.sources);
    if (problems.length)
      return reply.code(400).send({ error: 'invalid_scope', message: problems.join('; '), problems });
    return reply.code(201).send(await repos.cases.create(input, analyst));
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId', async (request, reply) => {
    const caseId = idOf(request.params.caseId);
    const found = caseId ? await repos.cases.get(caseId) : undefined;
    return found ?? notFound(reply, 'case');
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    const caseId = idOf(request.params.caseId);
    if (!caseId || !(await repos.cases.get(caseId))) return notFound(reply, 'case');
    return { items: await repos.runs.listByCase(caseId) };
  });

  app.post<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    const caseId = idOf(request.params.caseId);
    const kase = caseId ? await repos.cases.get(caseId) : undefined;
    if (!kase) return notFound(reply, 'case');
    const input = parse(StartRunSchema, request.body ?? {});
    if (input.trigger === 'rescore' || input.rescoreOfRunId) {
      const targetId = input.rescoreOfRunId?.toLowerCase();
      const target = targetId ? await repos.runs.get(targetId) : undefined;
      // Compare canonical ids as stored, not the URL spelling (UUIDs are case-insensitive).
      if (!target || target.caseId !== kase.id) {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'rescoreOfRunId must name an existing run of this case' });
      }
    }
    const rescoreOfRunId = input.rescoreOfRunId?.toLowerCase();
    return reply
      .code(202)
      .send(await deps.startRun(kase.id, { trigger: input.trigger, ...(rescoreOfRunId ? { rescoreOfRunId } : {}) }));
  });

  registerScheduleRoutes(app, {
    repos,
    mode: deps.mode ?? 'live',
    minIntervalMinutes: deps.schedule?.minIntervalMinutes ?? 60,
    analyst: deps.schedule?.analyst ?? analyst,
    clock: deps.schedule?.clock ?? (() => new Date()),
    idOf,
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await repos.runs.get(runId) : undefined;
    return run ?? notFound(reply, 'run');
  });

  /**
   * Run-scoped lists. Collected evidence (captures, observations, accounts, egress log) and the chain analysis derived
   * from it (transfers, address types, exclusions, activity, cash-outs) are read from the run that collected it — for a
   * rescore, the rescored run — while candidates, extraction results, links and changes stay per run.
   */
  const runList = <T>(path: string, load: (runId: string) => Promise<T[]>, scope: 'evidence' | 'run' = 'run') =>
    app.get<{ Params: { runId: string } }>(`/api/runs/:runId/${path}`, async (request, reply) => {
      const runId = idOf(request.params.runId);
      const run = runId ? await repos.runs.get(runId) : undefined;
      if (!run) return notFound(reply, 'run');
      return { items: await load(scope === 'evidence' ? evidenceRunIdOf(run) : run.id) };
    });
  runList('captures', (id) => repos.evidence.listCaptures(id), 'evidence');
  // Chain-of-custody events of the run's captures (empty when the store keeps none).
  runList(
    'custody',
    async (id) => repos.custody?.listBySubjects((await repos.evidence.listCaptures(id)).map((c) => c.id)) ?? [],
    'evidence',
  );
  runList('observations', (id) => repos.evidence.listObservations(id), 'evidence');
  runList('accounts', (id) => repos.evidence.listAccounts(id), 'evidence');
  runList('candidates', (id) => repos.evidence.listCandidates(id));
  // Extraction results include the matches rejected at validation (homoglyphs, transaction hashes, test vectors).
  runList('extractions', (id) => repos.evidence.listExtractionResults(id));
  runList('egress', (id) => repos.evidence.listEgressLog(id), 'evidence');
  runList('transfers', (id) => repos.chain.listTransfers(id), 'evidence');
  // Each link carries the analyst judgements recorded next to it (the assessment itself is never changed).
  runList('links', async (id) => withJudgements(repos, id, await repos.analysis.listLinks(id)));
  runList('exclusions', (id) => repos.analysis.listExclusions(id), 'evidence');
  // Address types behind A2/A3 (EOA, EIP-7702 delegation, Safe, ERC-4337 account, contract…); none without the port.
  runList('address-types', (id) => repos.addressTypes?.list(id) ?? Promise.resolve([]), 'evidence');
  runList('activity', (id) => repos.analysis.listActivity(id), 'evidence');
  runList('cash-outs', (id) => repos.analysis.listCashOuts(id), 'evidence');
  runList('changes', (id) => repos.analysis.listChanges(id));

  // Address labels (reference data, not run-scoped) with their provenance: dataset, URL, licence, lastmod.
  app.get('/api/labels', async () => ({ items: await repos.labels.list() }));

  app.get<{ Params: { captureId: string } }>('/api/captures/:captureId', async (request, reply) => {
    const captureId = idOf(request.params.captureId);
    const capture = captureId ? await repos.evidence.getCapture(captureId) : undefined;
    return capture ?? notFound(reply, 'capture');
  });

  // Stored evidence is untrusted third-party content: always a download, never rendered in the console's origin.
  app.get<{ Params: { sha256: string } }>('/api/blobs/:sha256', async (request, reply) => {
    const { sha256 } = request.params;
    if (!/^[0-9a-f]{64}$/.test(sha256)) return reply.code(400).send({ error: 'invalid_input', message: 'bad digest' });
    if (!(await deps.blobs.has(sha256))) return notFound(reply, 'blob');
    const bytes = await deps.blobs.get(sha256);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${sha256}.bin"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(Buffer.from(bytes));
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/report', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const report = runId ? await repos.analysis.latestReport(runId, 'html') : undefined;
    if (!report) return notFound(reply, 'report');
    const bytes = await deps.blobs.get(report.blobSha256);
    return reply
      .header('content-type', report.mediaType)
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });

  registerAnalystRoutes(app, {
    repos,
    sources: deps.sources,
    analyst,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.renderReport ? { renderReport: deps.renderReport } : {}),
  });

  return app;
}
