import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLabelLookup } from '../../packages/labels/src/index.ts';
import { writeFile } from 'node:fs/promises';
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

  it('keeps assets separate and every listing period readable', async () => {
    const dir = await dirPromise;
    const repos = createMemoryRepositories();
    const deps = { labels: repos.labels, dataDir: dir, now };
    const eth = '0x8888888888888888888888888888888888888888';
    const both = '0x9999999999999999999999999999999999999999';
    const write = async (name: string, list: string[]): Promise<string> => {
      const file = join(dir, name);
      await writeFile(file, JSON.stringify(list));
      return file;
    };
    const run = async (file: string, asset: string, version: string): Promise<void> => {
      await runImport({ datasetId: 'ofac-0xb10c', file, asset, version }, deps);
    };
    await run(await write('eth1.json', [eth, both]), 'ETH', '2026-10-01');
    await run(await write('usdt1.json', [both]), 'USDT', '2026-10-05');
    const active = async (address: string, date: string): Promise<number> =>
      (
        await new MemoryLabelLookup(await repos.labels.list()).labelsFor(
          { chain: 'evm:1', address },
          `${date}T00:00:00Z`,
        )
      ).length;
    // USDT snapshot does not end the ETH-only address
    expect(await active(eth, '2026-10-10')).toBe(1);
    // ETH delists it (2026-11-01), lists it again (2026-12-01): the first period stays readable
    await run(await write('eth2.json', [both]), 'ETH', '2026-11-01');
    await run(await write('eth3.json', [both, eth]), 'ETH', '2026-12-01');
    expect(await active(eth, '2026-10-10')).toBe(1);
    expect(await active(eth, '2026-11-15')).toBe(0);
    expect(await active(eth, '2026-12-05')).toBe(1);
  });
});
