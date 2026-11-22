/**
 * Wiring of the report's PDF step: Gotenberg (PDF/A-3b rendering) and osint-py (PAdES signing) are local services
 * reached only through the egress client as `internal_service` sources; the RFC 3161 time-stamp of the signature is
 * requested by the worker's timestamper. Enabled when `GOTENBERG_URL` is set and `OLCYS_REPORT_PDF` is not `false`.
 */
import type { SourceDescriptor, TrustedTimestamper } from '@olcys/core';
import { redBlockedHosts } from '@olcys/collectors';
import { createEgressClient } from '@olcys/http';
import type { ReportPdfOptions } from '@olcys/reporting';
import { TOOL_VERSION } from './config.ts';

const off = (value: string | undefined): boolean =>
  ['false', '0', 'no', 'off'].includes((value ?? '').trim().toLowerCase());

export function reportPdfOptions(options: {
  mode: 'live' | 'offline' | 'replay';
  env: Readonly<Record<string, string | undefined>>;
  sources: readonly SourceDescriptor[];
  timestamper?: TrustedTimestamper;
}): ReportPdfOptions | undefined {
  const { env, sources, mode } = options;
  const gotenbergUrl = env['GOTENBERG_URL']?.trim();
  if (!gotenbergUrl || off(env['OLCYS_REPORT_PDF'])) return undefined;
  const gotenberg = sources.find((s) => s.id === 'gotenberg' && s.kind === 'internal_service');
  if (!gotenberg) return undefined;
  const signing = !off(env['OLCYS_PDF_SIGNING']);
  const signingSource = signing
    ? sources.find((s) => s.id === 'pdf_signing' && s.kind === 'internal_service')
    : undefined;
  const canStamp = mode === 'live' && ((options.timestamper as { canFlush?: boolean } | undefined)?.canFlush ?? true);
  const gitCommit = env['OLCYS_GIT_COMMIT'];
  return {
    createHttp: ({ repos, blobs, runId }) =>
      createEgressClient({
        mode,
        runId,
        enabledSources: [gotenberg, ...(signingSource ? [signingSource] : [])],
        redHosts: redBlockedHosts(sources),
        blobs,
        sinks: {
          log: (entry) => repos.evidence.addEgressLog([entry]),
          provenance: (envelope) => repos.evidence.addRawFetches([envelope]),
        },
        toolVersion: TOOL_VERSION,
      }),
    ...(options.timestamper ? { timestamper: options.timestamper } : {}),
    config: {
      gotenbergUrl,
      signingUrl: env['OSINT_PY_URL']?.trim() || 'http://127.0.0.1:8090',
      signing: signingSource !== undefined,
      timestampSignature: canStamp,
    },
    ...(gitCommit ? { gitCommit } : {}),
  };
}
