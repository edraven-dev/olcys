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

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: deps.httpLog ?? false });
  const { repos } = deps;
  const analyst = deps.analyst ?? 'analityk';

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ContractError) {
      return reply.code(400).send({ error: 'invalid_input', message: error.message, issues: error.issues });
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
    const found = await repos.cases.get(request.params.caseId);
    return found ?? notFound(reply, 'case');
  });

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    if (!(await repos.cases.get(request.params.caseId))) return notFound(reply, 'case');
    return { items: await repos.runs.listByCase(request.params.caseId) };
  });

  app.post<{ Params: { caseId: string } }>('/api/cases/:caseId/runs', async (request, reply) => {
    if (!(await repos.cases.get(request.params.caseId))) return notFound(reply, 'case');
    const input = parse(StartRunSchema, request.body ?? {});
    return reply.code(202).send(await deps.startRun(request.params.caseId, input));
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
    const run = await repos.runs.get(request.params.runId);
    return run ?? notFound(reply, 'run');
  });

  const runList = <T>(path: string, load: (runId: string) => Promise<T[]>) =>
    app.get<{ Params: { runId: string } }>(`/api/runs/:runId/${path}`, async (request, reply) => {
      if (!(await repos.runs.get(request.params.runId))) return notFound(reply, 'run');
      return { items: await load(request.params.runId) };
    });
  runList('captures', (id) => repos.evidence.listCaptures(id));
  runList('observations', (id) => repos.evidence.listObservations(id));
  runList('accounts', (id) => repos.evidence.listAccounts(id));
  runList('candidates', (id) => repos.evidence.listCandidates(id));
  // Extraction results include the matches rejected at validation (homoglyphs, transaction hashes, test vectors).
  runList('extractions', (id) => repos.evidence.listExtractionResults(id));
  runList('egress', (id) => repos.evidence.listEgressLog(id));
  runList('transfers', (id) => repos.chain.listTransfers(id));
  runList('links', (id) => repos.analysis.listLinks(id));
  runList('exclusions', (id) => repos.analysis.listExclusions(id));
  runList('activity', (id) => repos.analysis.listActivity(id));
  runList('cash-outs', (id) => repos.analysis.listCashOuts(id));
  runList('changes', (id) => repos.analysis.listChanges(id));

  // Address labels (reference data, not run-scoped) with their provenance: dataset, URL, licence, lastmod.
  app.get('/api/labels', async () => ({ items: await repos.labels.list() }));

  app.get<{ Params: { captureId: string } }>('/api/captures/:captureId', async (request, reply) => {
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
