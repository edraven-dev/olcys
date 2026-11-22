/**
 * Test doubles for the egress port: canned responses (no network) or pass-through to the in-process fixture site
 * on 127.0.0.1. Both record every request so tests can assert purposes, identifiers and secrets.
 */
import { join } from 'node:path';
import type { EgressClient, EgressRequest, EgressResponse, RunContext } from '@olcys/core';
import { newId } from '@olcys/core';
import { createFixtureServer, type FixtureServer } from '../../../../apps/fixture-site/src/fixture-server.ts';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

export interface CannedResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: EgressRequest) => CannedResponse | Promise<CannedResponse>;

export class FakeEgressClient implements EgressClient {
  readonly requests: EgressRequest[] = [];
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  async fetch(request: EgressRequest): Promise<EgressResponse> {
    this.requests.push(request);
    const canned = await this.handler(request);
    const text = typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body);
    const body = new TextEncoder().encode(text);
    const now = new Date().toISOString();
    return {
      status: canned.status ?? 200,
      finalUrl: request.url,
      headers: canned.headers ?? {},
      body,
      text: () => text,
      json: <T>() => JSON.parse(text) as T,
      provenance: {
        fetchId: newId(),
        runId: request.runId,
        sourceId: request.sourceId,
        provider: request.sourceId,
        method: request.method ?? 'GET',
        url: request.url,
        requestedAt: now,
        receivedAt: now,
        httpStatus: canned.status ?? 200,
        responseHeaders: {},
        body: { sha256: '0'.repeat(64), bytes: body.byteLength, mediaType: 'application/json' },
        mode: 'offline',
        toolVersion: 'test',
        userAgent: 'test',
        egressLogId: newId(),
      },
    };
  }
}

/** Routes by URL substring; unmatched requests answer 404. */
export function routes(table: Record<string, CannedResponse | (() => CannedResponse)>): Handler {
  return (request) => {
    const match = Object.keys(table)
      .filter((key) => request.url.includes(key))
      .toSorted((a, b) => b.length - a.length)[0];
    if (match === undefined) return { status: 404, body: 'not found' };
    const entry = table[match];
    return typeof entry === 'function' ? entry() : (entry ?? { status: 404, body: 'not found' });
  };
}

export function testContext(http: EgressClient, runId = newId()): RunContext {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    runId,
    caseId: newId(),
    mode: 'offline',
    http,
    blobs: {
      put: () => Promise.reject(new Error('not used')),
      get: () => Promise.reject(new Error('not used')),
      has: () => Promise.resolve(false),
    },
    clock: { now: () => new Date('2026-11-21T12:00:00Z') },
    logger,
  };
}

export function startFixtureSite(): Promise<FixtureServer> {
  return createFixtureServer({
    root: join(REPO_ROOT, 'apps', 'fixture-site', 'public'),
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: false,
  });
}

/** Pass-through to the local fixture site (tests only; never leaves 127.0.0.1). */
export function fixtureEgress(): FakeEgressClient {
  return new FakeEgressClient(async (request) => {
    if (!request.url.startsWith('http://127.0.0.1:')) throw new Error(`test egress refuses ${request.url}`);
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return { status: response.status, body: await response.text() };
  });
}
