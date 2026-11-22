import type { CaptureDraft, Logger, RunContext } from '@olcys/core';
import { InMemoryBlobStore, createCaptureRecorder, injectedClockSync } from '../src/index.ts';

export const FIXED = new Date('2026-11-21T12:00:00.000Z');
export const fixedClock = { now: () => FIXED };

export function recordingLogger(): Logger & { warnings: { message: string; data?: Record<string, unknown> }[] } {
  const warnings: { message: string; data?: Record<string, unknown> }[] = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn(message, data) {
      warnings.push({ message, ...(data ? { data } : {}) });
    },
    error() {},
  };
}

export function makeContext(blobs = new InMemoryBlobStore(), logger = recordingLogger()) {
  const ctx: RunContext = {
    runId: '0190a000-0000-7000-8000-000000000001',
    caseId: '0190a000-0000-7000-8000-000000000002',
    mode: 'offline',
    http: { fetch: () => Promise.reject(new Error('no network in tests')) },
    blobs,
    clock: fixedClock,
    logger,
  };
  return { ctx, blobs, logger };
}

export function makeRecorder(options: { ids?: string[]; synced?: boolean } = {}) {
  const ids = [...(options.ids ?? ['0190a000-0000-7000-8000-0000000000a1'])];
  return createCaptureRecorder({
    clockSync: injectedClockSync(options.synced ?? true, fixedClock),
    collector: { name: 'analityk-testowy', host: 'stanowisko-1', ip: '192.0.2.10', ipSource: 'configured' },
    toolVersion: '0.0.0-test',
    gitCommit: 'abc1234',
    newId: () => ids.shift() ?? '0190a000-0000-7000-8000-0000000000ff',
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

/** A synthetic profile page capture with every browser artifact. */
export function fullDraft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    sourceId: 'fixture_site',
    profile: 'web_page',
    userAgent: 'OLCYS/test',
    fetchIds: ['0190a000-0000-7000-8000-0000000000f1'],
    url: 'https://forum.example.test/profile/fikcyjny_kacper',
    finalUrl: 'https://forum.example.test/profile/fikcyjny_kacper',
    startedAt: '2026-11-21T11:59:58.000Z',
    collectedAt: '2026-11-21T11:59:59.000Z',
    endedAt: '2026-11-21T12:00:00.000Z',
    httpStatus: 200,
    status: 'ok',
    serverIp: '198.51.100.7',
    responseHeaders: { 'content-type': 'text/html' },
    artifacts: [
      { kind: 'html', bytes: enc('<html>profil</html>'), mediaType: 'text/html', description: 'response body' },
      { kind: 'rendered_html', bytes: enc('<html>dom</html>'), mediaType: 'text/html', description: 'rendered DOM' },
      {
        kind: 'screenshot',
        bytes: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png',
        description: 'full page',
      },
      { kind: 'text', bytes: enc('profil tekst'), mediaType: 'text/plain', description: 'inner text' },
      { kind: 'headers', bytes: enc('{"status":200}'), mediaType: 'application/json', description: 'headers' },
    ],
    transformations: ['rendered_html: DOM serialised by Chromium after load'],
    ...overrides,
  };
}
