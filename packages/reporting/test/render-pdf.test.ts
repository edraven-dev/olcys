import type { EgressClient, EgressRequest, EgressResponse, TimestampOutcome, TimestampSubject } from '@olcys/core';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import {
  buildReportManifest,
  createReportManifest,
  PDF_MAX_BYTES,
  PdfRenderError,
  renderReport,
  renderReportPdf,
  type ReportPdfDeps,
} from '../src/index.ts';
import { personaData } from './fixtures.ts';

const PDF = new TextEncoder().encode('%PDF-1.7 fake rendered');
const SIGNED = new TextEncoder().encode('%PDF-1.7 fake signed');

function response(status: number, body: Uint8Array | object, headers: Record<string, string> = {}): EgressResponse {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    finalUrl: '',
    headers,
    body: bytes,
    text: () => new TextDecoder().decode(bytes),
    json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    provenance: {} as EgressResponse['provenance'],
  };
}

interface Stubs {
  requests: EgressRequest[];
  gotenberg?: (request: EgressRequest) => EgressResponse;
  signing?: (request: EgressRequest) => EgressResponse;
}

function fakeHttp(stubs: Stubs): EgressClient {
  const ok = {
    convert: () => response(200, PDF, { 'Gotenberg-Remediation-Residual': '0' }),
    validate: () => response(200, { 'report.pdf': { profile: 'PDF/A-3b', compliant: true, violations: [] } }),
    prepare: () => response(200, { sessionId: 'sess', signatureDigestSha256: 'ab'.repeat(32) }),
    finish: (timestamped: boolean) =>
      response(200, {
        pdfBase64: Buffer.from(SIGNED).toString('base64'),
        signerCertSha256: 'cd'.repeat(32),
        signedAt: '2026-01-01T00:00:00Z',
        timestamped,
      }),
  };
  return {
    async fetch(request) {
      stubs.requests.push(request);
      if (request.sourceId === 'gotenberg') {
        if (stubs.gotenberg) return stubs.gotenberg(request);
        return request.url.endsWith('/validate') ? ok.validate() : ok.convert();
      }
      if (stubs.signing) return stubs.signing(request);
      if (request.url.endsWith('/prepare')) return ok.prepare();
      const sent = JSON.parse(String(request.body)) as { timestampTokenBase64: string | null };
      return ok.finish(sent.timestampTokenBase64 !== null);
    },
  };
}

function timestamper(outcome: (s: TimestampSubject) => TimestampOutcome) {
  const subjects: TimestampSubject[] = [];
  return { subjects, stamp: async (s: TimestampSubject) => (subjects.push(s), outcome(s)) };
}

const TOKEN = new Uint8Array([1, 2, 3]);
const granted = (): TimestampOutcome => ({
  status: 'granted',
  tokenDer: TOKEN,
  token: {
    tsaUrl: 'https://tsa.invalid/tsr',
    token: { sha256: 'ef'.repeat(32), bytes: 3, mediaType: 'application/timestamp-reply' },
    genTime: '2026-01-01T00:00:00Z',
    hashAlgorithm: 'sha256',
    messageImprint: 'ab'.repeat(32),
  },
});

async function setup(stubs: Stubs, extra: Partial<ReportPdfDeps> = {}, config: Partial<ReportPdfDeps['config']> = {}) {
  const data = personaData();
  const html = renderReport(data);
  const blobs = new InMemoryBlobStore();
  const manifest = await createReportManifest(data, 'f'.repeat(64), blobs);
  const deps: ReportPdfDeps = {
    http: fakeHttp(stubs),
    blobs,
    config: { gotenbergUrl: 'http://127.0.0.1:3100', signingUrl: 'http://127.0.0.1:8090', signing: true, ...config },
    ...extra,
  };
  return { data, html, manifest, deps, blobs };
}

describe('report manifest', () => {
  it('is canonical, schema-tagged and carries the digest the HTML prints', async () => {
    const { data, manifest } = await setup({ requests: [] });
    const built = buildReportManifest(manifest);
    expect(built.json).toBe(buildReportManifest(manifest).json);
    expect(JSON.parse(built.json).schema).toBe('olcys.report-manifest/1');
    expect(renderReport(data)).toContain(manifest.reportModelSha256);
  });
});

describe('renderReportPdf', () => {
  it('signs and time-stamps the signature (B-T): one egress request per call', async () => {
    const stubs: Stubs = { requests: [] };
    const tsa = timestamper(granted);
    const { html, manifest, deps } = await setup(stubs, { timestamper: tsa });
    const result = await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    expect(result.status).toBe('signed_timestamped');
    expect(stubs.requests.map((r) => [r.sourceId, r.url.replace(/^.*:\d+/, '')])).toEqual([
      ['gotenberg', '/forms/chromium/convert/html'],
      ['gotenberg', '/forms/pdf/validate'],
      ['pdf_signing', '/v1/pdf/sign/prepare'],
      ['pdf_signing', '/v1/pdf/sign/finish'],
    ]);
    expect(stubs.requests.every((r) => r.containsIdentifier)).toBe(true);
    expect(tsa.subjects.map((s) => s.type)).toEqual(['report_signature']);
    expect(tsa.subjects[0]?.digest).toBe('ab'.repeat(32));
    expect(result.artifacts.map((a) => a.kind).toSorted()).toEqual([
      'manifest_json',
      'pdf',
      'pdf_signed',
      'timestamp_reply',
    ]);
    expect(result.pdfa).toEqual({ profile: 'PDF/A-3b', compliant: true, residual: 0 });
  });

  it('sends the manifest as the second uploaded file and the stages', async () => {
    const stubs: Stubs = { requests: [] };
    const { html, manifest, deps } = await setup(stubs, {}, { signing: false });
    await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    const body = new TextDecoder().decode(stubs.requests[0]?.body as Uint8Array);
    expect(body).toContain('filename="index.html"');
    expect(body).toContain('filename="manifest.json"');
    expect(body).toContain('"op":"remediate","profile":"PDF/A-3b"');
    expect(body.indexOf('"op":"attach"')).toBeLessThan(body.indexOf('"op":"remediate"'));
    expect(body).toContain('failOnResourceLoadingFailed');
  });

  it('offline: status signed (B-B) and a queued report_pdf request over the signed PDF', async () => {
    const tsa = timestamper(() => ({ status: 'queued', reason: 'offline' }));
    const { html, manifest, deps } = await setup({ requests: [] }, { timestamper: tsa }, { timestampSignature: false });
    const result = await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    expect(result.status).toBe('signed');
    expect(tsa.subjects).toHaveLength(1);
    expect(tsa.subjects[0]?.type).toBe('report_pdf');
    const { createHash } = await import('node:crypto');
    expect(tsa.subjects[0]?.digest).toBe(createHash('sha256').update(SIGNED).digest('hex'));
    expect(result.timestamp).toEqual({ status: 'queued', reason: 'offline' });
  });

  it('a refused token falls back to a signature without time-stamp', async () => {
    let finishes = 0;
    const stubs: Stubs = {
      requests: [],
      signing: (request) => {
        if (request.url.endsWith('/prepare'))
          return response(200, { sessionId: 's', signatureDigestSha256: 'ab'.repeat(32) });
        finishes += 1;
        return finishes === 1
          ? response(400, { code: 'timestamp_mismatch' })
          : response(200, {
              pdfBase64: Buffer.from(SIGNED).toString('base64'),
              signerCertSha256: 'cd'.repeat(32),
              signedAt: 'x',
              timestamped: false,
            });
      },
    };
    const tsa = timestamper((s) =>
      s.type === 'report_signature' ? granted() : { status: 'queued', reason: 'offline' },
    );
    const { html, manifest, deps } = await setup(stubs, { timestamper: tsa });
    const result = await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    expect(result.status).toBe('signed');
    expect(tsa.subjects.map((s) => s.type)).toEqual(['report_signature', 'report_pdf']);
  });

  it('osint-py unreachable: unsigned with pdf and manifest stored and one warning', async () => {
    const stubs: Stubs = {
      requests: [],
      signing: () => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const { html, manifest, deps } = await setup(stubs);
    const result = await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    expect(result.status).toBe('unsigned');
    expect(result.warnings).toEqual(['signing_unavailable']);
    expect(result.artifacts.map((a) => a.kind).toSorted()).toEqual(['manifest_json', 'pdf']);
    const stored = await Promise.all(result.artifacts.map((a) => deps.blobs.has(a.blob.sha256)));
    expect(stored).toEqual([true, true]);
  });

  it('a PDF above the signing limit is left unsigned without calling the signing service', async () => {
    const stubs: Stubs = {
      requests: [],
      gotenberg: (r) =>
        r.url.endsWith('/validate')
          ? response(200, { f: { compliant: true, violations: [] } })
          : response(200, new Uint8Array(PDF_MAX_BYTES + 1), { 'gotenberg-remediation-residual': '0' }),
    };
    const { html, manifest, deps } = await setup(stubs);
    const result = await renderReportPdf({ reportId: 'r1', html, manifest }, deps);
    expect(result.status).toBe('unsigned');
    expect(result.warnings).toEqual(['signing_unavailable']);
    expect(stubs.requests.some((r) => r.sourceId === 'pdf_signing')).toBe(false);
  });

  it('external references: no request is made and it throws', async () => {
    const stubs: Stubs = { requests: [] };
    const { html, manifest, deps } = await setup(stubs);
    const evil = html.replace('<body>', '<body><img src="https://example.org/x.png">');
    await expect(renderReportPdf({ reportId: 'r1', html: evil, manifest }, deps)).rejects.toThrow(/self-contained/);
    expect(stubs.requests).toHaveLength(0);
  });

  it('rejects a residual or a non-compliant PDF', async () => {
    const residual: Stubs = {
      requests: [],
      gotenberg: () => response(200, PDF, { 'Gotenberg-Remediation-Residual': '3' }),
    };
    const a = await setup(residual);
    await expect(renderReportPdf({ reportId: 'r1', html: a.html, manifest: a.manifest }, a.deps)).rejects.toThrow(
      PdfRenderError,
    );
    const invalid: Stubs = {
      requests: [],
      gotenberg: (r) =>
        r.url.endsWith('/validate')
          ? response(200, { 'report.pdf': { compliant: false, violations: [{ rule: 'x' }] } })
          : response(200, PDF, { 'gotenberg-remediation-residual': '0' }),
    };
    const b = await setup(invalid);
    await expect(renderReportPdf({ reportId: 'r1', html: b.html, manifest: b.manifest }, b.deps)).rejects.toThrow(
      /not PDF\/A/,
    );
  });

  it('Gotenberg unreachable throws a typed error', async () => {
    const stubs: Stubs = {
      requests: [],
      gotenberg: () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const { html, manifest, deps } = await setup(stubs);
    await expect(renderReportPdf({ reportId: 'r1', html, manifest }, deps)).rejects.toMatchObject({
      code: 'gotenberg_unreachable',
    });
  });
});
