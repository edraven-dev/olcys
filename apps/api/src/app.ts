/**
 * HTTP API for the analyst console. Reads the append-only store through the repository ports; starting a run hands
 * it to the pipeline (in-process in the MVP). Inputs are validated with the `@olcys/core` schemas.
 */
import type { BlobStore, Repositories, RunWithProgress, SourceDescriptor } from '@olcys/core';
import { ContractError, CORE_CONTRACTS_VERSION, CreateCaseSchema, parse, StartRunSchema } from '@olcys/core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

export interface ApiDeps {
  repos: Repositories;
  blobs: BlobStore;
  sources: readonly SourceDescriptor[];
  /** Creates a run for the case and starts the pipeline without waiting for it. */
  startRun(
    caseId: string,
    input: { trigger?: 'manual' | 'rescore'; rescoreOfRunId?: string },
  ): Promise<RunWithProgress>;
  /** Who acts; the MVP has a single local analyst. */
  analyst?: string;
  /** Fastify request logging. */
  httpLog?: boolean;
}

const notFound = (reply: FastifyReply, what: string) =>
  reply.code(404).send({ error: 'not_found', message: `${what} not found` });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids are UUIDs; anything else cannot exist and must not reach the database. */
const isId = (value: string): boolean => UUID.test(value);

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: deps.httpLog ?? false });
  const { repos } = deps;
  const analyst = deps.analyst ?? 'analityk';

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
    return reply.code(201).send(await repos.cases.create(input, analyst));
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId', async (request, reply) => {
    if (!isId(request.params.caseId)) return notFound(reply, 'case');
    const found = await repos.cases.get(request.params.caseId);
    return found ?? notFound(reply, 'case');
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    if (!isId(request.params.caseId) || !(await repos.cases.get(request.params.caseId))) return notFound(reply, 'case');
    return { items: await repos.runs.listByCase(request.params.caseId) };
  });

  app.post<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    const { caseId } = request.params;
    if (!isId(caseId) || !(await repos.cases.get(caseId))) return notFound(reply, 'case');
    const input = parse(StartRunSchema, request.body ?? {});
    if (input.trigger === 'rescore' || input.rescoreOfRunId) {
      const target = input.rescoreOfRunId ? await repos.runs.get(input.rescoreOfRunId) : undefined;
      if (!target || target.caseId !== caseId) {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'rescoreOfRunId must name an existing run of this case' });
      }
    }
    return reply.code(202).send(await deps.startRun(caseId, input));
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
    if (!isId(request.params.runId)) return notFound(reply, 'run');
    const run = await repos.runs.get(request.params.runId);
    return run ?? notFound(reply, 'run');
  });

  const runList = <T>(path: string, load: (runId: string) => Promise<T[]>) =>
    app.get<{ Params: { runId: string } }>(`/api/runs/:runId/${path}`, async (request, reply) => {
      if (!isId(request.params.runId) || !(await repos.runs.get(request.params.runId))) return notFound(reply, 'run');
      return { items: await load(request.params.runId) };
    });
  runList('captures', (id) => repos.evidence.listCaptures(id));
  runList('observations', (id) => repos.evidence.listObservations(id));
  runList('accounts', (id) => repos.evidence.listAccounts(id));
  runList('candidates', (id) => repos.evidence.listCandidates(id));
  runList('egress', (id) => repos.evidence.listEgressLog(id));
  runList('transfers', (id) => repos.chain.listTransfers(id));
  runList('links', (id) => repos.analysis.listLinks(id));
  runList('exclusions', (id) => repos.analysis.listExclusions(id));
  runList('activity', (id) => repos.analysis.listActivity(id));
  runList('cash-outs', (id) => repos.analysis.listCashOuts(id));
  runList('changes', (id) => repos.analysis.listChanges(id));

  app.get<{ Params: { captureId: string } }>('/api/captures/:captureId', async (request, reply) => {
    if (!isId(request.params.captureId)) return notFound(reply, 'capture');
    const capture = await repos.evidence.getCapture(request.params.captureId);
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
    if (!isId(request.params.runId)) return notFound(reply, 'run');
    const report = await repos.analysis.latestReport(request.params.runId, 'html');
    if (!report) return notFound(reply, 'report');
    const bytes = await deps.blobs.get(report.blobSha256);
    return reply
      .header('content-type', report.mediaType)
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });

  return app;
}
