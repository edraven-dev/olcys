import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileBlobStore, InMemoryBlobStore, verifyCapture } from '../src/index.ts';
import { fullDraft, makeContext, makeRecorder } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'olcys-verify-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function findFile(root: string, digest: string): Promise<string> {
  for (const entry of await readdir(root, { recursive: true })) {
    if (entry === digest || entry.endsWith(`/${digest}`)) return join(root, entry);
  }
  throw new Error('blob file not found');
}

describe('verifyCapture', () => {
  it('is ok for an intact capture', async () => {
    const { ctx, blobs } = makeContext(new InMemoryBlobStore());
    const capture = await makeRecorder().record(fullDraft(), ctx);
    const result = await verifyCapture(capture.manifestSha256, blobs);
    expect(result.ok).toBe(true);
    expect(result.manifest).toBe('ok');
    expect(result.artifacts).toHaveLength(5);
  });

  it('flags the overwritten artifact and only that one', async () => {
    const blobs = new FileBlobStore(dir);
    const { ctx } = makeContext();
    ctx.blobs = blobs;
    const capture = await makeRecorder().record(fullDraft(), ctx);
    const html = capture.artifacts.find((a) => a.kind === 'html')!;
    await writeFile(await findFile(dir, html.blob.sha256), 'zmienione');
    const result = await verifyCapture(capture.manifestSha256, blobs);
    expect(result.ok).toBe(false);
    expect(result.manifest).toBe('ok');
    expect(result.artifacts.filter((a) => a.result === 'digest_mismatch').map((a) => a.kind)).toEqual(['html']);
    expect(result.artifacts.filter((a) => a.result === 'ok')).toHaveLength(4);
  });

  it('reports a missing, altered or invalid manifest', async () => {
    const blobs = new FileBlobStore(dir);
    expect(await verifyCapture('a'.repeat(64), blobs)).toEqual({ ok: false, manifest: 'missing', artifacts: [] });
    const ref = await blobs.put(new TextEncoder().encode('{"nie":"manifest"}'), 'application/json');
    expect((await verifyCapture(ref.sha256, blobs)).manifest).toBe('schema_invalid');
    await writeFile(await findFile(dir, ref.sha256), 'x');
    expect((await verifyCapture(ref.sha256, blobs)).manifest).toBe('digest_mismatch');
  });
});
