import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryRepositories } from '../../packages/db/src/index.ts';
import { runImport } from './import.ts';

const fx = (name: string): string =>
  new URL(`../../packages/labels/test/fixtures/datasets/${name}`, import.meta.url).pathname;
const dirPromise = mkdtemp(join(tmpdir(), 'olcys-import-'));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));
const now = (): Date => new Date('2026-11-22T08:00:00Z');

describe('labels:import', () => {
  it('refuses non-open datasets and eth-labels without a justification', async () => {
    const deps = { labels: createMemoryRepositories().labels, dataDir: await dirPromise, now };
    expect(await runImport({ datasetId: 'opensanctions', file: fx('tagpack.synthetic.yaml') }, deps)).toMatchObject({
      status: 'refused',
      reason: 'dataset_licence_refused',
    });
    expect(await runImport({ datasetId: 'dune-spellbook', file: fx('tagpack.synthetic.yaml') }, deps)).toMatchObject({
      reason: 'dataset_licence_refused',
    });
    expect(await runImport({ datasetId: 'eth-labels', file: 'x.sqlite' }, deps)).toMatchObject({
      reason: 'justification_required',
    });
  });

  it('imports a TagPack once; importing identical content again is a no-op', async () => {
    const repos = createMemoryRepositories();
    const deps = { labels: repos.labels, dataDir: await dirPromise, now };
    const options = { datasetId: 'graphsense-tagpacks', file: fx('tagpack.synthetic.yaml'), version: 'abc1234' };
    const first = await runImport(options, deps);
    expect(first).toMatchObject({ status: 'imported', count: 2 });
    const stored = await repos.labels.list();
    await runImport(options, deps);
    expect(await repos.labels.list()).toHaveLength(stored.length);
  });

  it('imports OFAC snapshots as versions and PoR files under the profile', async () => {
    const repos = createMemoryRepositories();
    const deps = { labels: repos.labels, dataDir: await dirPromise, now };
    await runImport(
      { datasetId: 'ofac-0xb10c', file: fx('ofac-v1.synthetic.json'), asset: 'XBT', version: '2026-10-01' },
      deps,
    );
    await runImport(
      { datasetId: 'ofac-0xb10c', file: fx('ofac-v2.synthetic.json'), asset: 'XBT', version: '2026-11-20' },
      deps,
    );
    const ended = (await repos.labels.list()).filter((l) => l.attributes.activeTo === '2026-11-19');
    expect(ended).toHaveLength(1);
    const por = await runImport(
      { datasetId: 'por-file', file: fx('por-okx.synthetic.csv'), profile: 'okx', version: '2026-11-01' },
      deps,
    );
    expect(por).toMatchObject({ status: 'imported', count: 3 });
  });

  it('writes entity registers to the data directory', async () => {
    const dir = await dirPromise;
    const outcome = await runImport(
      { datasetId: 'esma-casps', file: fx('casps.synthetic.csv'), version: '2026-11-21' },
      { labels: undefined, dataDir: dir, now },
    );
    expect(outcome).toMatchObject({ status: 'imported', count: 2 });
    const written = JSON.parse(await readFile(join(dir, 'entities', 'esma_casps.json'), 'utf8')) as {
      records: unknown[];
    };
    expect(written.records).toHaveLength(2);
  });
});
