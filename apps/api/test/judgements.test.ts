import { createHash } from 'node:crypto';
import type { AnalystJudgement, LinkAssessment } from '@olcys/core';
import { canonicalJson, newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analystName } from '../src/analyst-routes.ts';
import { buildApp } from '../src/app.ts';
import { ADDRESS, ANALYST, analystStages, newCase, silent } from './analyst-fixtures.ts';

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let runId: string;
let link: LinkAssessment;

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const stored = async (id: string) => (await runtime.repos.analysis.listLinks(runId)).find((l) => l.id === id);
const judge = (linkId: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/links/${linkId}/judgements`, payload: payload as object });

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: (rt) => analystStages(rt.sources),
  });
  app = buildApp({ ...runtime, analyst: ANALYST });
  const caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
  runId = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json().id as string;
  await runtime.idle();
  const links = (await app.inject(`/api/runs/${runId}/links`)).json().items as LinkAssessment[];
  link = links.find((l) => l.address.address === ADDRESS.wallet)!;
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('analyst judgements', () => {
  it('records a judgement next to the link and leaves the stored assessment byte-identical', async () => {
    expect(link.score).toBeGreaterThan(0);
    const before = digest(await stored(link.id));
    const caseId = (await runtime.repos.runs.get(runId))!.caseId;
    const runsBefore = (await runtime.repos.runs.listByCase(caseId)).length;

    const response = await judge(link.id, {
      judgement: 'not_same',
      justification: '  Inny autor: konto prowadzi osoba o innym stylu pisania.  ',
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as AnalystJudgement;
    expect(created).toMatchObject({
      linkAssessmentId: link.id,
      judgement: 'not_same',
      justification: 'Inny autor: konto prowadzi osoba o innym stylu pisania.',
      analyst: ANALYST,
    });

    expect(digest(await stored(link.id))).toBe(before);
    const listed = (await app.inject(`/api/runs/${runId}/links`)).json().items as (LinkAssessment & {
      judgements: AnalystJudgement[];
    })[];
    const same = listed.find((l) => l.id === link.id)!;
    expect(same.score).toBe(link.score);
    expect(same.judgements).toEqual([created]);
    // A judgement never triggers a rescore.
    expect((await runtime.repos.runs.listByCase(caseId)).length).toBe(runsBefore);
  });

  it('validates the justification and the link; the analyst comes from the server, not the body', async () => {
    const short = await judge(link.id, { judgement: 'same', justification: '123456789' });
    expect([short.statusCode, short.json().error]).toEqual([422, 'justification_too_short']);
    const long = await judge(link.id, { judgement: 'same', justification: 'x'.repeat(2001) });
    expect([long.statusCode, long.json().error]).toEqual([422, 'justification_too_long']);
    const unknown = await judge(newId(), { judgement: 'same', justification: 'Uzasadnienie wystarczająco długie' });
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'link_not_found']);
    expect((await judge('not-a-uuid', { judgement: 'same', justification: 'x'.repeat(20) })).statusCode).toBe(404);
    expect((await app.inject(`/api/links/${newId()}/judgements`)).json().error).toBe('link_not_found');
    const bad = await judge(link.id, { judgement: 'maybe', justification: 'Uzasadnienie wystarczająco długie' });
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'invalid_input']);

    const forged = await judge(link.id, {
      judgement: 'unsure',
      justification: 'Dowody nie pozwalają rozstrzygnąć.',
      analyst: 'ktoś inny',
    });
    expect(forged.statusCode).toBe(201);
    expect(forged.json().analyst).toBe(ANALYST);
  });

  it('lists judgements oldest first; the latest is current and nothing is updated', async () => {
    const other = (await app.inject(`/api/runs/${runId}/links`))
      .json()
      .items.find((l: LinkAssessment) => l.address.address === ADDRESS.repaired) as LinkAssessment;
    const before = digest(await stored(other.id));
    const values = ['same', 'unsure', 'not_same'] as const;
    for (const judgement of values) {
      // oxlint-disable-next-line no-await-in-loop
      const r = await judge(other.id, { judgement, justification: `Ocena analityka: ${judgement} (test)` });
      expect(r.statusCode).toBe(201);
    }
    const items = (await app.inject(`/api/links/${other.id}/judgements`)).json().items as AnalystJudgement[];
    // Oldest first: the current judgement (the latest) is the last one.
    expect(items.map((j) => j.judgement)).toEqual([...values]);
    expect(items.at(-1)?.judgement).toBe('not_same');
    expect(await runtime.repos.judgements!.listByLink(other.id)).toHaveLength(3);
    expect(digest(await stored(other.id))).toBe(before);
  });

  it('advertises judgements in the meta document only when the store supports them', async () => {
    const meta = (await app.inject('/api/meta')).json();
    expect(meta).toMatchObject({ mode: 'offline', features: { judgements: true, suggestions: false } });
    expect(meta.scoring.weightsVersion).toMatch(/^weights\.v\d+$/);

    const { judgements: _j, overrides: _o, ...plain } = createMemoryRepositories();
    const bare = buildApp({ ...runtime, repos: plain });
    expect((await bare.inject('/api/meta')).json().features.judgements).toBe(false);
    expect(
      (await bare.inject({ method: 'POST', url: `/api/links/${link.id}/judgements`, payload: {} })).statusCode,
    ).toBe(404);
    await bare.close();
  });

  it('takes the analyst name from OLCYS_ANALYST_NAME, else OLCYS_COLLECTOR_NAME', () => {
    expect(analystName({ OLCYS_ANALYST_NAME: ' Jan Analityk ', OLCYS_COLLECTOR_NAME: 'dev' })).toBe('Jan Analityk');
    expect(analystName({ OLCYS_ANALYST_NAME: '', OLCYS_COLLECTOR_NAME: 'dev-analyst' })).toBe('dev-analyst');
    expect(analystName({})).toBeUndefined();
  });
});
