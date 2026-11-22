/**
 * `pnpm demo`: drives the RUNNING local stack (API + fixture site) through the whole synthetic scenario: persona case,
 * run 1 on fixture variant v1, run 2 on v2 (the wallet swap), then reads the results back through the API, checks them
 * against `fixtures/demo/manifest.json` and prints a Polish summary. `--ci` exits 1 with a diff on any mismatch.
 * Loopback URLs only. Out of scope for now: sandbox chains (regtest/Anvil), cassette recording, `--mode sandbox`,
 * username enumeration.
 */
import { personaCase } from '../dev/persona.ts';
import {
  compareRuns,
  type CashOutLike,
  type ChangeLike,
  type ExclusionLike,
  type ExtractionLike,
  type LinkLike,
  type RunResults,
} from './compare.ts';
import { loadExpectations, type Expectations } from './expectations.ts';
import { assertLoopbackUrl, isUnreachable, localRequest, NotLoopbackError } from './local-http.ts';
import { pl } from './pl.ts';
import { summarise } from './summary.ts';

export interface DemoOptions {
  apiUrl: string;
  fixtureUrl: string;
  /** The web app's origin, only used for the link in the summary. */
  webUrl?: string;
  ci?: boolean;
  log?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
}

export interface DemoResult {
  ok: boolean;
  /** 0, or 1 when `ci` is set and the self-check found a mismatch. */
  exitCode: number;
  caseId: string;
  runIds: [string, string];
  checks: number;
  mismatches: { check: string; expected: string; actual: string }[];
}

/** An environment problem with an actionable Polish message (service down, variant switch off, run failed). */
export class DemoError extends Error {}

/** The persona case as seeded, plus the synthetic archive (GREEN) the persona pipeline test enables too. */
export const demoCase = {
  ...personaCase,
  scope: {
    ...personaCase.scope,
    enabledSources: [...personaCase.scope.enabledSources, 'wayback_cdx'],
  },
};

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const log = options.log ?? ((line: string) => console.info(line));
  const api = assertLoopbackUrl(options.apiUrl);
  const fixture = assertLoopbackUrl(options.fixtureUrl);
  const web = assertLoopbackUrl(options.webUrl ?? 'http://127.0.0.1:5173');
  const pollMs = options.pollMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const expect = await loadExpectations();

  log(pl.health(api, fixture));
  const health = await localRequest(`${api}/api/health`);
  if (isUnreachable(health) || health.status !== 200)
    throw new DemoError(pl.apiDown(api, isUnreachable(health) ? health.cause : `HTTP ${health.status}`));
  const fixtureHealth = await localRequest(`${fixture}/healthz`);
  if (isUnreachable(fixtureHealth) || fixtureHealth.status !== 200)
    throw new DemoError(
      pl.fixtureDown(fixture, isUnreachable(fixtureHealth) ? fixtureHealth.cause : `HTTP ${fixtureHealth.status}`),
    );

  const setVariant = async (variant: 'v1' | 'v2') => {
    const response = await localRequest(`${fixture}/__fixture/variant`, {
      method: 'POST',
      body: variant,
      contentType: 'text/plain',
    });
    if (isUnreachable(response)) throw new DemoError(pl.fixtureDown(fixture, response.cause));
    if (response.status !== 204) throw new DemoError(pl.variantSwitchOff());
    log(pl.step.variant(variant));
  };

  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await localRequest(`${api}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' }),
    });
    if (isUnreachable(response)) throw new DemoError(pl.apiDown(api, response.cause));
    if (response.status >= 300) {
      throw new DemoError(pl.step.http(`${method} ${path}`, response.status, response.text));
    }
    return JSON.parse(response.text) as T;
  };

  const execute = async (n: number, caseId: string): Promise<string> => {
    const started = await json<{ id: string }>('POST', `/api/cases/${caseId}/runs`, {});
    log(pl.step.run(n, started.id));
    const deadline = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const run = await json<{ status: string; progress?: Record<string, unknown>; error?: string }>(
        'GET',
        `/api/runs/${started.id}`,
      );
      const step = typeof run.progress?.['step'] === 'string' ? run.progress['step'] : undefined;
      const line = pl.step.progress(run.status, step);
      if (line !== last) log(line);
      last = line;
      if (TERMINAL.has(run.status)) {
        if (run.status === 'failed' || run.status === 'cancelled') {
          throw new DemoError(pl.step.failed(n, run.status, run.error));
        }
        log(pl.step.done(n, run.status));
        return started.id;
      }
      if (Date.now() > deadline) throw new DemoError(pl.step.timeout(n));
      // oxlint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
  };

  const read = async (runId: string): Promise<RunResults> => {
    const items = async <T>(path: string): Promise<T[]> =>
      (await json<{ items: T[] }>('GET', `/api/runs/${runId}/${path}`)).items;
    const run = await json<{ status: string }>('GET', `/api/runs/${runId}`);
    const report = await localRequest(`${api}/api/runs/${runId}/report`);
    return {
      runId,
      status: run.status,
      links: await items<LinkLike>('links'),
      exclusions: await items<ExclusionLike>('exclusions'),
      extractions: await items<ExtractionLike>('extractions'),
      cashOuts: await items<CashOutLike>('cash-outs'),
      changes: await items<ChangeLike>('changes'),
      ...(!isUnreachable(report) && report.status === 200 ? { reportHtml: report.text } : {}),
    };
  };

  await setVariant('v1');
  const kase = await json<{ id: string }>('POST', '/api/cases', demoCase);
  log(pl.step.case(kase.id));
  const run1 = await execute(1, kase.id);
  await setVariant('v2');
  const run2 = await execute(2, kase.id);

  const v1 = await read(run1);
  const v2 = await read(run2);
  return finish(expect, { api, web, caseId: kase.id, v1, v2, ci: options.ci ?? false, log });
}

function finish(
  expect: Expectations,
  o: {
    api: string;
    web: string;
    caseId: string;
    v1: RunResults;
    v2: RunResults;
    ci: boolean;
    log: (l: string) => void;
  },
): DemoResult {
  const outcome = compareRuns(expect, o.v1, o.v2);
  for (const line of summarise({
    caseId: o.caseId,
    apiUrl: o.api,
    webUrl: o.web,
    v1: o.v1,
    v2: o.v2,
    expect,
    outcome,
  }))
    o.log(line);
  const ok = outcome.mismatches.length === 0;
  return {
    ok,
    exitCode: !ok && o.ci ? 1 : 0,
    caseId: o.caseId,
    runIds: [o.v1.runId, o.v2.runId],
    checks: outcome.checks,
    mismatches: outcome.mismatches,
  };
}

/** URLs from the environment: explicit overrides first, else loopback with the configured ports. */
export function urlsFromEnv(env: Record<string, string | undefined>): {
  apiUrl: string;
  fixtureUrl: string;
  webUrl: string;
} {
  return {
    apiUrl: env['API_URL'] ?? `http://127.0.0.1:${env['API_PORT'] ?? '4000'}`,
    fixtureUrl: env['FIXTURE_SITE_URL'] ?? `http://127.0.0.1:${env['FIXTURE_PORT'] ?? '4100'}`,
    webUrl: env['WEB_URL'] ?? `http://127.0.0.1:${env['WEB_PORT'] ?? '5173'}`,
  };
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((a) => a !== '--ci');
  if (unknown.length > 0) {
    console.error(`Nieznane argumenty: ${unknown.join(' ')}. Użycie: pnpm demo [--ci]`);
    process.exit(2);
  }
  try {
    const result = await runDemo({
      ...urlsFromEnv(process.env),
      ci: args.has('--ci'),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof NotLoopbackError ? pl.refuseNonLoopback(error.message) : (error as Error).message);
    process.exitCode = 1;
  }
}
