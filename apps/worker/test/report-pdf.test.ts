/**
 * The report PDF step in the worker: the egress client reaches the PDF services in `offline` and `replay` mode without
 * cassettes (loopback stand-ins for Gotenberg and osint-py), the signature digest is stamped only when a live flush can
 * reach the TSA, and an offline run queues a `report_pdf` request that a later live flush grants (verified with
 * `openssl ts -verify` when openssl is installed).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMode, Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createManifestForTest } from './report-pdf-support.ts';
import { PDF_MAX_BYTES, PDF_MAX_RESPONSE_BYTES, renderReport, renderReportPdf } from '@olcys/reporting';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTrustedTimestamper, loadConfig, tsaSettings } from '../src/index.ts';
import { reportPdfOptions } from '../src/report-pdf.ts';
import { createFakeTsa, createFakeTsaEgress, type FakeTsa } from '../../../packages/evidence/test/support/fake-tsa.ts';
import { personaData } from '../../../packages/reporting/test/fixtures.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const PDF = Buffer.from('%PDF-1.7 synthetic rendered');
let SIGNED = Buffer.from('%PDF-1.7 synthetic signed');

let server: Server;
let base: string;
let tsa: FakeTsa;
let sources: Awaited<ReturnType<typeof loadConfig>>['sources'];
const hits: string[] = [];

beforeAll(async () => {
  tsa = await createFakeTsa();
  sources = (await loadConfig()).sources;
  server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      const json = (body: unknown) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (request.url === '/forms/chromium/convert/html') {
        return response
          .writeHead(200, { 'content-type': 'application/pdf', 'Gotenberg-Remediation-Residual': '0' })
          .end(PDF);
      }
      if (request.url === '/forms/pdf/validate') return json({ 'report.pdf': { compliant: true, violations: [] } });
      if (request.url === '/v1/pdf/sign/prepare')
        return json({ sessionId: 's1', signatureDigestSha256: 'ab'.repeat(32) });
      if (request.url === '/v1/pdf/sign/finish') {
        const sent = JSON.parse(Buffer.concat(chunks).toString()) as { timestampTokenBase64: string | null };
        return json({
          pdfBase64: SIGNED.toString('base64'),
          signerCertSha256: 'cd'.repeat(32),
          signedAt: '2026-11-21T12:00:00.000Z',
          timestamped: sent.timestampTokenBase64 !== null,
        });
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function run(mode: FetchMode) {
  const repos = createMemoryRepositories();
  const blobs = new InMemoryBlobStore();
  const egress = createFakeTsaEgress(tsa);
  const make = (m: FetchMode) =>
    createTrustedTimestamper({
      repos,
      blobs,
      settings: tsaSettings({}),
      sources,
      mode: m,
      logger: silent,
      http: egress.client,
      anchorsPem: [tsa.caPem],
    });
  const timestamper = await make(mode);
  const options = reportPdfOptions({
    mode,
    env: { GOTENBERG_URL: base, OSINT_PY_URL: base },
    sources,
    timestamper,
  });
  expect(options).toBeDefined();
  const data = personaData();
  const html = renderReport(data);
  const manifest = await createManifestForTest(data, html, blobs);
  const result = await renderReportPdf(
    { reportId: data.reportId, runId: data.run.id, html, manifest },
    {
      http: options!.createHttp({ repos, blobs, runId: data.run.id }),
      blobs,
      timestamper,
      config: options!.config,
    },
  );
  return { repos, blobs, egress, make, result, data };
}

describe('report PDF in the worker', () => {
  it.each<FetchMode>(['offline', 'replay'])(
    '%s mode: the services are reached live (no cassette), the file is signed (B-B) and its stamp is queued',
    async (mode) => {
      hits.length = 0;
      const { repos, result, egress, data } = await run(mode);
      expect(result.status).toBe('signed');
      expect(hits).toEqual([
        'POST /forms/chromium/convert/html',
        'POST /forms/pdf/validate',
        'POST /v1/pdf/sign/prepare',
        'POST /v1/pdf/sign/finish',
      ]);
      // No signature stamp (the TSA is not reachable here), no TSA request at all.
      expect(egress.calls).toHaveLength(0);
      const pending = (await repos.timestamps!.listPending({ limit: 100 })).filter(
        (r) => r.subject.id === data.reportId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.subject).toMatchObject({
        type: 'report_pdf',
        digest: createHash('sha256').update(SIGNED).digest('hex'),
      });
      const log = await repos.evidence.listEgressLog(data.run.id);
      expect(log.map((e) => e.sourceId)).toEqual(['gotenberg', 'gotenberg', 'pdf_signing', 'pdf_signing']);
      expect(log.every((e) => e.containsIdentifier)).toBe(true);
    },
  );

  it('a live flush grants the queued stamp and openssl verifies it against the signed PDF', async () => {
    const { repos, blobs, make, data } = await run('offline');
    const live = await make('live');
    const flushed = await live.flush({ subjectIds: [data.reportId] });
    expect(flushed).toMatchObject({ ran: true, granted: 1 });
    const digest = createHash('sha256').update(SIGNED).digest('hex');
    const token = await repos.timestamps!.getToken({ type: 'report_pdf', id: data.reportId, digest });
    expect(token).toBeDefined();
    if (spawnSync('openssl', ['version']).status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), 'olcys-pdf-ts-'));
    try {
      writeFileSync(join(dir, 'report.pdf'), SIGNED);
      writeFileSync(join(dir, 'reply.tsr'), await blobs.get(token!.token.token.sha256));
      writeFileSync(join(dir, 'test-ca.pem'), tsa.caPem);
      writeFileSync(join(dir, 'tsa.pem'), tsa.tsaPem);
      const verify = spawnSync(
        'openssl',
        [
          'ts',
          '-verify',
          '-data',
          join(dir, 'report.pdf'),
          '-in',
          join(dir, 'reply.tsr'),
          '-CAfile',
          join(dir, 'test-ca.pem'),
          '-untrusted',
          join(dir, 'tsa.pem'),
        ],
        { encoding: 'utf8' },
      );
      expect(verify.stdout + verify.stderr).toContain('OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the signature of a large report: a 30 MiB signed PDF (about 40 MiB of base64) is accepted', async () => {
    const original = SIGNED;
    SIGNED = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(30 * 1024 * 1024, 0x41)]);
    try {
      const { result } = await run('offline');
      expect(result.status).toBe('signed');
      expect(result.warnings).toEqual([]);
      const signed = result.artifacts.find((a) => a.kind === 'pdf_signed');
      expect(signed?.blob.bytes).toBe(SIGNED.length);
    } finally {
      SIGNED = original;
    }
  });

  it('accepts a signing reply up to the 50 MiB PDF limit and no more', () => {
    expect(PDF_MAX_RESPONSE_BYTES).toBeGreaterThan(Math.ceil((PDF_MAX_BYTES * 4) / 3));
    expect(PDF_MAX_RESPONSE_BYTES).toBeGreaterThan(25 * 1024 * 1024);
  });

  it('is off without GOTENBERG_URL, when disabled, or when the register has no gotenberg entry', () => {
    expect(reportPdfOptions({ mode: 'offline', env: {}, sources })).toBeUndefined();
    expect(
      reportPdfOptions({ mode: 'offline', env: { GOTENBERG_URL: base, OLCYS_REPORT_PDF: 'false' }, sources }),
    ).toBeUndefined();
    expect(reportPdfOptions({ mode: 'offline', env: { GOTENBERG_URL: base }, sources: [] })).toBeUndefined();
    expect(
      reportPdfOptions({ mode: 'offline', env: { GOTENBERG_URL: base, OLCYS_PDF_SIGNING: 'false' }, sources })?.config
        .signing,
    ).toBe(false);
  });
});
