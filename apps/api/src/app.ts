/**
 * HTTP API for the analyst console. Reads the append-only store through the repository ports; starting a run hands
 * it to the pipeline (in-process in the MVP). Inputs are validated with the `@olcys/core` schemas.
 */
import { createHash } from 'node:crypto';
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
import { createSourceRegister, validateCaseScope, type ScopeViolation } from '@olcys/collectors';
import {
  ContractError,
  CORE_CONTRACTS_VERSION,
  CreateCaseSchema,
  newId,
  nowIso,
  parse,
  StartRunSchema,
} from '@olcys/core';
import { EXPORT_FILE_EXTENSIONS, EXPORT_KINDS, findExportSet, isExportKind } from '@olcys/reporting';
import { evidenceRunIdOf, TOOL_VERSION } from '@olcys/worker';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { DEFAULT_ANALYST, registerAnalystRoutes, supportsJudgements, withJudgements } from './analyst-routes.ts';
import { registerGuard, type GuardOptions } from './guard.ts';
import { idOf } from './ids.ts';
import { registerScheduleRoutes } from './schedule-routes.ts';
import { httpLogOptions, registerAccessLog, registerSecurityHeaders, reportCsp } from './security.ts';

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
  /** Adds `Strict-Transport-Security`: only when the API is served over TLS (`OLCYS_HSTS=1`). */
  hsts?: boolean;
  /** Fastify request logging. */
  httpLog?: boolean;
  /** Destination of the request log (default: stdout); for tests. */
  logStream?: { write(line: string): void };
  /** Extra allowed `Host` headers and `Origin`s on top of the loopback defaults (see `guard.ts`). */
  guard?: GuardOptions;
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

const describeViolation = (v: ScopeViolation): string => {
  switch (v.code) {
    case 'justification_too_short':
      return `source ${v.sourceId}: the justification needs at least ${v.minLength} characters`;
    case 'pivot_depth_out_of_range':
      return `maxPivotDepth must be between ${v.min} and ${v.max}`;
    case 'unknown_chain':
      return `unknown chain ${v.chain}`;
    default:
      return `source ${v.sourceId}: ${v.code}`;
  }
};

const notFound = (reply: FastifyReply, what: string) =>
  reply.code(404).send({ error: 'not_found', message: `${what} not found` });

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.httpLog ? { ...httpLogOptions(), ...(deps.logStream ? { stream: deps.logStream } : {}) } : false,
  });
  const { repos } = deps;
  const analyst = deps.analyst ?? DEFAULT_ANALYST;
  const sourceRegister = createSourceRegister(deps.sources);

  // DNS rebinding and cross-site writes: the API has no authentication, so it only serves its own console.
  registerGuard(app, deps.guard);
  registerSecurityHeaders(app, { hsts: deps.hsts ?? false });
  registerAccessLog(app, {
    repos,
    // The analyst label recorded with judgements when configured, otherwise a fixed local actor.
    analyst: deps.analyst ?? 'local',
    onError: (error) => app.log.error({ err: error }, 'access log write failed'),
  });

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
    // --- source register: scope validation (RED, AMBER justification, unknown ids, pivot depth, chains) ---
    const violations = validateCaseScope(input.scope, sourceRegister);
    const [first] = violations;
    if (first) {
      return reply.code(400).send({
        error: first.code,
        message: violations.map(describeViolation).join('; '),
        details: violations,
      });
    }
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
  // Bitcoin co-spend clusters: a heuristic result with its merge evidence and skipped transactions; none without the port.
  runList('clusters', (id) => repos.clusters?.list(id) ?? Promise.resolve([]), 'evidence');
  runList('activity', (id) => repos.analysis.listActivity(id), 'evidence');
  runList('cash-outs', (id) => repos.analysis.listCashOuts(id), 'evidence');
  runList('changes', (id) => repos.analysis.listChanges(id));

  // Who viewed or exported which case and why (append-only log; the one local analyst reads it).
  app.get<{ Querystring: { caseId?: string; actor?: string; limit?: string } }>(
    '/api/access-log',
    async (request, reply) => {
      if (!repos.accessLog) return notFound(reply, 'access log');
      const { caseId, actor, limit } = request.query;
      const id = caseId === undefined ? undefined : idOf(caseId);
      if (caseId !== undefined && !id) return reply.code(400).send({ error: 'invalid_input', message: 'bad caseId' });
      const n = limit === undefined ? 100 : Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return reply.code(400).send({ error: 'invalid_input', message: 'limit is 1-500' });
      }
      return {
        items: await repos.accessLog.list({ ...(id ? { caseId: id } : {}), ...(actor ? { actor } : {}), limit: n }),
      };
    },
  );

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
    const bytes = Buffer.from(await deps.blobs.get(report.blobSha256));
    // The report's own stylesheets are allowed by hash; it has no script.
    return reply
      .header('content-type', report.mediaType)
      .header('content-security-policy', reportCsp(bytes.toString('utf8')))
      .send(bytes);
  });

  // Exports available for the run's current report (none for runs rendered before exports existed).
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/exports', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await repos.runs.get(runId) : undefined;
    if (!run) return notFound(reply, 'run');
    const set = await findExportSet(deps, run.id);
    return {
      items: EXPORT_KINDS.flatMap((format) => {
        const e = set?.exports[format];
        return e ? [{ format, mediaType: e.mediaType, sha256: e.sha256 }] : [];
      }),
    };
  });

  // STIX, MISP and CSV exports of the run's latest report: a download that leaves the tool is a custody event.
  app.get<{ Params: { runId: string; format: string } }>('/api/runs/:runId/exports/:format', async (request, reply) => {
    const runId = idOf(request.params.runId);
    const run = runId ? await repos.runs.get(runId) : undefined;
    if (!run) return notFound(reply, 'run');
    const { format } = request.params;
    if (!isExportKind(format)) {
      return reply.code(400).send({ error: 'invalid_input', message: `format is one of ${EXPORT_KINDS.join(', ')}` });
    }
    // Only files of the current report version; a missing or damaged blob is never recorded as an export.
    const stored = (await findExportSet(deps, run.id))?.exports[format];
    if (!stored || !(await deps.blobs.has(stored.sha256))) return notFound(reply, 'export');
    const bytes = await deps.blobs.get(stored.sha256);
    if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256) {
      deps.logger?.error('stored export does not match its digest', { runId: run.id, format });
      return reply.code(500).send({ error: 'integrity_error', message: 'stored export does not match its digest' });
    }
    if (request.method === 'GET') {
      const kase = await repos.cases.get(run.caseId);
      await repos.custody?.add([
        {
          id: newId(),
          at: nowIso(),
          actor: analyst,
          action: 'exported',
          runId: run.id,
          subject: { type: 'report', id: run.id },
          detail: { format, blobSha256: stored.sha256, purpose: kase?.purpose ?? '' },
        },
      ]);
      deps.logger?.info('report export downloaded', { runId: run.id, format, analyst });
    }
    return reply
      .header('content-type', stored.mediaType)
      .header('content-disposition', `attachment; filename="olcys-${run.id}-${EXPORT_FILE_EXTENSIONS[format]}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
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
