/**
 * Integration with a real, hardened Gotenberg (compose service `gotenberg`, or an isolated container started with the
 * same environment) and, optionally, osint-py. Skipped unless OLCYS_IT_GOTENBERG=1. Variables:
 *   GOTENBERG_URL (default http://127.0.0.1:3100), OLCYS_IT_OSINT_PY_URL (enables the signing check),
 *   OLCYS_IT_CANARY_HOST (host name the container can use to reach this machine, default host.containers.internal).
 * This file is a test, so it may use `fetch` and a loopback server (the network guard exempts tests).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EgressClient, EgressResponse } from '@olcys/core';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { createReportManifest, PDFA_PROFILE, renderReport, renderReportPdf, type ReportPdfDeps } from '../src/index.ts';
import { personaData } from './fixtures.ts';

const enabled = process.env['OLCYS_IT_GOTENBERG'] === '1';
const gotenbergUrl = process.env['GOTENBERG_URL'] ?? 'http://127.0.0.1:3100';
const signingUrl = process.env['OLCYS_IT_OSINT_PY_URL'];
const canaryHost = process.env['OLCYS_IT_CANARY_HOST'] ?? 'host.containers.internal';

const passThrough: EgressClient = {
  async fetch(request) {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body as string } : {}),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      finalUrl: request.url,
      headers: Object.fromEntries(response.headers),
      body,
      text: () => new TextDecoder().decode(body),
      json: <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
      provenance: {} as EgressResponse['provenance'],
    };
  },
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function postForm(path: string, form: FormData): Promise<Response> {
  return fetch(`${gotenbergUrl}${path}`, { method: 'POST', body: form });
}

describe.skipIf(!enabled)('hardened Gotenberg', () => {
  const data = personaData();
  const html = renderReport(data);
  const deps = (signing: boolean): ReportPdfDeps & { blobs: InMemoryBlobStore } => {
    const blobs = new InMemoryBlobStore();
    return {
      http: passThrough,
      blobs,
      config: { gotenbergUrl, ...(signingUrl ? { signingUrl } : {}), signing, timestampSignature: false },
    };
  };

  it('renders the persona report to PDF/A-3b with the manifest attached (AC1, AC2)', { timeout: 120_000 }, async () => {
    const d = deps(false);
    const manifest = await createReportManifest(data, sha256(new TextEncoder().encode(html)), d.blobs);
    const result = await renderReportPdf({ reportId: data.reportId, runId: data.run.id, html, manifest }, d);
    expect(result.pdfa).toEqual({ profile: PDFA_PROFILE, compliant: true, residual: 0 });
    const pdfRef = result.artifacts.find((a) => a.kind === 'pdf')?.blob;
    const manifestRef = result.artifacts.find((a) => a.kind === 'manifest_json')?.blob;
    expect(pdfRef && manifestRef).toBeTruthy();
    const pdf = await d.blobs.get(pdfRef?.sha256 ?? '');
    const manifestBytes = await d.blobs.get(manifestRef?.sha256 ?? '');

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'report.pdf');
    form.append('profile', PDFA_PROFILE);
    const validation = (await (await postForm('/forms/pdf/validate', form)).json()) as Record<
      string,
      { compliant: boolean; violations: unknown[] }
    >;
    expect(Object.values(validation)[0]).toMatchObject({ compliant: true, violations: [] });

    const extract = new FormData();
    extract.append('files', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'report.pdf');
    const attachment = await postForm('/forms/pdf/extract-attachments', extract);
    expect(attachment.status).toBe(200);
    // One attachment is returned as the file itself (several would come as an archive).
    expect(attachment.headers.get('content-disposition')).toContain('manifest.json');
    const extracted = new Uint8Array(await attachment.arrayBuffer());
    expect(sha256(extracted)).toBe(sha256(manifestBytes));
    const parsed = JSON.parse(new TextDecoder().decode(extracted)) as { reportModelSha256: string };
    expect(html).toContain(parsed.reportModelSha256);
  });

  it('cannot fetch anything outside the uploaded files (AC3)', { timeout: 120_000 }, async () => {
    let hits = 0;
    const canary = createServer((_request, reply) => {
      hits += 1;
      reply.writeHead(404).end();
    });
    await new Promise<void>((resolve) => canary.listen(0, '0.0.0.0', resolve));
    const port = (canary.address() as AddressInfo).port;
    try {
      for (const src of [
        'https://example.org/x.png',
        'http://fixture-site:4100/healthz',
        `http://${canaryHost}:${port}/canary.png`,
        `http://127.0.0.1:${port}/canary.png`,
      ]) {
        for (const strict of [false, true]) {
          const form = new FormData();
          form.append(
            'files',
            new Blob([`<!doctype html><html><body><p>x</p><img src="${src}"></body></html>`], { type: 'text/html' }),
            'index.html',
          );
          if (strict) form.append('failOnResourceLoadingFailed', 'true');
          // oxlint-disable-next-line no-await-in-loop
          const response = await postForm('/forms/chromium/convert/html', form);
          // The request filter blocks the resource: the PDF is rendered without the image (never an error page).
          expect([200, 409]).toContain(response.status);
        }
      }
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => canary.close(resolve));
    }
  });

  it.skipIf(!signingUrl)(
    'a signed PDF is still PDF/A-3b (AC5, without a time-stamp)',
    { timeout: 180_000 },
    async () => {
      const d = deps(true);
      const manifest = await createReportManifest(data, sha256(new TextEncoder().encode(html)), d.blobs);
      const result = await renderReportPdf({ reportId: data.reportId, runId: data.run.id, html, manifest }, d);
      expect(result.status).toBe('signed');
      expect(result.signature?.timestamped).toBe(false);
      const signedRef = result.artifacts.find((a) => a.kind === 'pdf_signed')?.blob;
      const signed = await d.blobs.get(signedRef?.sha256 ?? '');
      expect(signed.length).toBeGreaterThan(0);
      expect(new TextDecoder('latin1').decode(signed)).toContain('/ByteRange');
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(signed)], { type: 'application/pdf' }), 'signed.pdf');
      form.append('profile', PDFA_PROFILE);
      const validation = (await (await postForm('/forms/pdf/validate', form)).json()) as Record<
        string,
        { compliant: boolean }
      >;
      expect(Object.values(validation)[0]?.compliant).toBe(true);
    },
  );
});
