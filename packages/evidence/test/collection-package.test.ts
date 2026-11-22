import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, FileBlobStore, InMemoryBlobStore, writeCollectionPackage } from '../src/index.ts';
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
});
