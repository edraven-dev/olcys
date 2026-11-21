import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobIntegrityError, BlobNotFoundError, FileBlobStore, InMemoryBlobStore, sha256Hex } from '../src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('sha256Hex', () => {
  it('matches the empty-string vector', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('FileBlobStore', () => {
  it('stores content-addressed, dedupes and verifies on read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'olcys-blobs-'));
    const store = new FileBlobStore(root);
    const a = await store.put(bytes('<html>persona</html>'), 'text/html');
    const b = await store.put(bytes('<html>persona</html>'), 'text/html');
    expect(a).toEqual(b);
    expect(a.sha256).toBe(sha256Hex('<html>persona</html>'));
    expect(new TextDecoder().decode(await store.get(a.sha256))).toBe('<html>persona</html>');
    const dir = join(root, 'sha256', a.sha256.slice(0, 2), a.sha256.slice(2, 4));
    expect((await readdir(dir)).toSorted()).toEqual([a.sha256, `${a.sha256}.json`]);
  });

  it('detects corruption and missing blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'olcys-blobs-'));
    const store = new FileBlobStore(root);
    const ref = await store.put(bytes('original'), 'text/plain');
    await writeFile(join(root, 'sha256', ref.sha256.slice(0, 2), ref.sha256.slice(2, 4), ref.sha256), 'tampered');
    await expect(store.get(ref.sha256)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(store.get('0'.repeat(64))).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('handles concurrent puts of the same content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'olcys-blobs-'));
    const store = new FileBlobStore(root);
    const refs = await Promise.all(Array.from({ length: 50 }, () => store.put(bytes('same'), 'text/plain')));
    expect(new Set(refs.map((r) => r.sha256)).size).toBe(1);
    const dir = join(root, 'sha256', refs[0]!.sha256.slice(0, 2), refs[0]!.sha256.slice(2, 4));
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('InMemoryBlobStore', () => {
  it('round-trips', async () => {
    const store = new InMemoryBlobStore();
    const ref = await store.put(bytes('x'), 'text/plain');
    expect(await store.has(ref.sha256)).toBe(true);
    expect(new TextDecoder().decode(await store.get(ref.sha256))).toBe('x');
  });

  it('isolates stored bytes from callers', async () => {
    const store = new InMemoryBlobStore();
    const input = bytes('evidence');
    const ref = await store.put(input, 'text/plain');
    input[0] = 0;
    const first = await store.get(ref.sha256);
    first[1] = 0;
    expect(new TextDecoder().decode(await store.get(ref.sha256))).toBe('evidence');
  });
});
