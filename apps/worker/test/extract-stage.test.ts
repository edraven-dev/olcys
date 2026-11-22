/**
 * The extract stage on stored captures: only `ok` captures are extracted, a rescore re-extracts the rescored run's
 * evidence into its own run, a repeated stage run stores nothing twice, a failure persists nothing, and no secret
 * reaches the stored rows or the log. In-memory store and blob store, no network.
 */
import { vi } from 'vitest';
import type { Capture, Logger, Repositories } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { gen, fragments } from '../../../packages/address-extractor/test/helpers.ts';
import { createExtractStage, type StageContext } from '../src/index.ts';

const enc = new TextEncoder();

function logCollector(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string, d?: Record<string, unknown>): void => void lines.push(JSON.stringify({ m, d }));
  return { logger: { debug: push, info: push, warn: push, error: push }, lines };
}

async function capture(
  repos: Repositories,
  blobs: InMemoryBlobStore,
  runId: string,
  html: string,
  status: Capture['status'] = 'ok',
): Promise<Capture> {
  const blob = await blobs.put(enc.encode(html), 'text/html; charset=utf-8');
  const c: Capture = {
    id: newId(),
    runId,
    sourceId: 'bitcointalk',
    url: 'http://127.0.0.1:4100/p',
    finalUrl: 'http://127.0.0.1:4100/p',
    collectedAt: nowIso(),
    collector: 'test',
    clockSynced: true,
    toolVersion: '0.1.0',
    userAgent: 'test',
    httpStatus: status === 'ok' ? 200 : 403,
    status,
    artifacts: status === 'ok' ? [{ kind: 'html', blob }] : [],
    manifestSha256: '0'.repeat(64),
    fetchIds: [],
  };
  await repos.evidence.addCaptures([c]);
  return c;
}

function ctxOf(
  repos: Repositories,
  blobs: InMemoryBlobStore,
  logger: Logger,
  runId: string,
  evidenceRunId: string,
): StageContext {
  return {
    run: { id: runId } as StageContext['run'],
    evidenceRunId,
    case: {} as StageContext['case'],
    repos,
    blobs,
    logger,
    progress: async () => {},
    markPartial: () => {},
  };
}

describe('extract stage', () => {
  it('extracts ok captures only, keeps secrets out of rows and log, and is repeatable without duplicates', async () => {
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const { logger, lines } = logCollector();
    const runId = newId();
    const address = gen.p2wpkh('stage-addr');
    const secrets = [gen.wif('stage-wif'), gen.xprv('stage-xprv'), gen.mnemonic24('stage-m24'), gen.hex64('stage-hex')];
    const html = `<p>Mój portfel: ${address}<br>WIF: ${secrets[0]}<br>xprv: ${secrets[1]}<br>Seed: ${secrets[2]}<br>klucz prywatny: ${secrets[3]}</p>`;
    const ok = await capture(repos, blobs, runId, html);
    await capture(repos, blobs, runId, '<p>login</p>', 'blocked');

    const stage = createExtractStage();
    await stage.run(ctxOf(repos, blobs, logger, runId, runId));

    const results = await repos.evidence.listExtractionResults(runId);
    expect(results).toHaveLength(1);
    expect(results[0]?.captureId).toBe(ok.id);
    expect(results[0]?.secrets.map((s) => s.kind).toSorted()).toEqual(
      ['hex64_private_key_context', 'seed_phrase', 'wif', 'xprv'].toSorted(),
    );
    expect(results[0]?.candidates.map((c) => c.address.address)).toEqual([address]);

    const stored = JSON.stringify([results, await repos.evidence.listCandidates(runId)]);
    for (const secret of secrets) {
      for (const piece of fragments(secret)) {
        expect(stored).not.toContain(piece);
        expect(lines.join('\n')).not.toContain(piece);
      }
    }
    expect(lines.join('\n')).toContain('extraction finished');

    // Running the stage again for the same run stores nothing twice.
    await stage.run(ctxOf(repos, blobs, logger, runId, runId));
    expect(await repos.evidence.listExtractionResults(runId)).toHaveLength(1);
    expect(await repos.evidence.listCandidates(runId)).toHaveLength(1);
  });

  it('a rescore re-extracts the rescored run evidence into its own run', async () => {
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const evidenceRun = newId();
    const rescoreRun = newId();
    const ok = await capture(repos, blobs, evidenceRun, `<p>Adres: ${gen.p2wpkh('rescore')}</p>`);
    await createExtractStage().run(ctxOf(repos, blobs, logCollector().logger, rescoreRun, evidenceRun));
    expect(await repos.evidence.listExtractionResults(evidenceRun)).toHaveLength(0);
    const rescored = await repos.evidence.listExtractionResults(rescoreRun);
    expect(rescored.map((r) => r.captureId)).toEqual([ok.id]);
  });

  it('persists nothing when extraction throws', async () => {
    vi.resetModules();
    vi.doMock('@olcys/address-extractor', async (original) => {
      const actual = await original<typeof import('@olcys/address-extractor')>();
      let calls = 0;
      return {
        ...actual,
        extractCapture: async (...args: Parameters<typeof actual.extractCapture>) => {
          calls += 1;
          if (calls === 2) throw new actual.SecretLeakError(1);
          return actual.extractCapture(...args);
        },
      };
    });
    const { createExtractStage: createStage } = await import('../src/stages.ts');
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const runId = newId();
    await capture(repos, blobs, runId, `<p>${gen.p2wpkh('throw-1')}</p>`);
    await capture(repos, blobs, runId, `<p>${gen.p2wpkh('throw-2')}</p>`);
    await expect(createStage().run(ctxOf(repos, blobs, logCollector().logger, runId, runId))).rejects.toThrow(
      /secret leak guard/,
    );
    expect(await repos.evidence.listExtractionResults(runId)).toEqual([]);
    expect(await repos.evidence.listCandidates(runId)).toEqual([]);
    vi.doUnmock('@olcys/address-extractor');
  });
});
