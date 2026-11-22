import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@olcys/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactIntegrityError,
  FileBlobStore,
  InMemoryBlobStore,
  OutputDirectoryNotEmptyError,
  writeCollectionPackage,
} from '../src/index.ts';
import { fullDraft, makeContext, makeRecorder } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'olcys-package-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeCollectionPackage', () => {
  it('writes manifests, artifacts, sorted SHA256SUMS and a Polish read-me', async () => {
    const blobs = new FileBlobStore(join(dir, 'blobs'));
    const { ctx } = makeContext();
    ctx.blobs = blobs;
    const capture = await makeRecorder().record(fullDraft(), ctx);
    const out = join(dir, 'paczka');
    const { files } = await writeCollectionPackage([capture.manifestSha256], out, blobs);

    expect(files).toContain(`manifests/${capture.id}.json`);
    const html = capture.artifacts.find((a) => a.kind === 'html')!;
    expect(files).toContain(`artifacts/${capture.id}/html-${html.blob.sha256.slice(0, 12)}.html`);
    expect(files).toContain('CZYTAJ_MNIE.txt');
    expect(files).toContain('SHA256SUMS');
    expect(await readFile(join(out, 'CZYTAJ_MNIE.txt'), 'utf8')).toContain('sha256sum -c SHA256SUMS');

    const manifestFile = await readFile(join(out, `manifests/${capture.id}.json`));
    expect(createHash('sha256').update(manifestFile).digest('hex')).toBe(capture.manifestSha256);

    const lines = (await readFile(join(out, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    const paths = lines.map((l) => l.slice(66));
    expect(paths).toEqual(paths.toSorted());
    for (const line of lines) {
      const [sha, path] = [line.slice(0, 64), line.slice(66)];
      // oxlint-disable-next-line no-await-in-loop
      const content = await readFile(join(out, path));
      expect(createHash('sha256').update(content).digest('hex')).toBe(sha);
    }
  });

  it('refuses a manifest whose artifact is missing', async () => {
    const source = makeContext();
    const capture = await makeRecorder().record(fullDraft(), source.ctx);
    const partial = new InMemoryBlobStore();
    await partial.put(await source.blobs.get(capture.manifestSha256), 'application/json');
    await expect(writeCollectionPackage([capture.manifestSha256], join(dir, 'x'), partial)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it('refuses a crafted manifest whose capture id would escape the package directory', async () => {
    const source = makeContext();
    const capture = await makeRecorder().record(fullDraft(), source.ctx);
    const manifest = JSON.parse(new TextDecoder().decode(await source.blobs.get(capture.manifestSha256)));
    manifest.captureId = '../../escaped';
    const crafted = await source.blobs.put(new TextEncoder().encode(canonicalJson(manifest)), 'application/json');
    const out = join(dir, 'a', 'b', 'paczka');
    await expect(writeCollectionPackage([crafted.sha256], out, source.blobs)).rejects.toThrow(
      /ENOENT|schema|digest|outside/,
    );
    await expect(readFile(join(dir, 'escaped.json'))).rejects.toThrow(/ENOENT|schema|digest|outside/);
    await expect(readFile(join(dir, 'a', 'escaped.json'))).rejects.toThrow(/ENOENT|schema|digest|outside/);
  });

  it('does not treat a storage error as a missing artifact', async () => {
    const source = makeContext();
    const capture = await makeRecorder().record(fullDraft(), source.ctx);
    const failing = {
      put: source.blobs.put.bind(source.blobs),
      has: async () => true,
      get: async (sha: string) => {
        if (sha === capture.manifestSha256) return source.blobs.get(sha);
        throw new Error('EACCES: permission denied');
      },
    };
    await expect(writeCollectionPackage([capture.manifestSha256], join(dir, 'x'), failing)).rejects.toThrow(/EACCES/);
  });

  it('refuses a non-empty output directory before writing anything', async () => {
    const source = makeContext();
    const capture = await makeRecorder().record(fullDraft(), source.ctx);
    const out = join(dir, 'zajety');
    await mkdir(out);
    await writeFile(join(out, 'stary.txt'), 'plik z innej paczki');
    await expect(writeCollectionPackage([capture.manifestSha256], out, source.blobs)).rejects.toBeInstanceOf(
      OutputDirectoryNotEmptyError,
    );
    expect(await readdir(out)).toEqual(['stary.txt']);
    // An existing empty directory is fine.
    const empty = join(dir, 'pusty');
    await mkdir(empty);
    await expect(writeCollectionPackage([capture.manifestSha256], empty, source.blobs)).resolves.toBeDefined();
  });
});
