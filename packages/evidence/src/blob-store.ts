import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BlobRef, BlobStore, Sha256Hex } from '@olcys/core';

export function sha256Hex(data: Uint8Array | string): Sha256Hex {
  return createHash('sha256').update(data).digest('hex');
}

export class BlobIntegrityError extends Error {
  readonly sha256: string;
  constructor(sha256: string) {
    super(`blob ${sha256} failed its integrity check`);
    this.name = 'BlobIntegrityError';
    this.sha256 = sha256;
  }
}

export class BlobNotFoundError extends Error {
  readonly sha256: string;
  constructor(sha256: string) {
    super(`blob ${sha256} not found`);
    this.name = 'BlobNotFoundError';
    this.sha256 = sha256;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Immutable content-addressed storage: `<root>/sha256/<aa>/<bb>/<digest>` plus a `<digest>.json` sidecar
 * (media type, size, first stored). Writes are atomic (temp file + rename); existing digests are never overwritten;
 * reads re-verify the hash.
 */
export class FileBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(sha256: string): string {
    if (!SHA256.test(sha256)) throw new TypeError(`invalid sha256: ${sha256}`);
    return join(this.root, 'sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const sha256 = sha256Hex(bytes);
    const ref: BlobRef = { sha256, bytes: bytes.byteLength, mediaType };
    const target = this.pathFor(sha256);
    if (await this.has(sha256)) return ref;
    await mkdir(dirname(target), { recursive: true, mode: 0o750 });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o640 });
    await rename(temp, target);
    await writeFile(
      `${target}.json`,
      JSON.stringify({ mediaType, bytes: bytes.byteLength, firstStoredAt: new Date().toISOString() }),
      { mode: 0o640, flag: 'wx' },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return ref;
  }

  async get(sha256: Sha256Hex): Promise<Uint8Array> {
    let data: Buffer;
    try {
      data = await readFile(this.pathFor(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(sha256);
      throw error;
    }
    if (sha256Hex(data) !== sha256) throw new BlobIntegrityError(sha256);
    return new Uint8Array(data);
  }

  async has(sha256: Sha256Hex): Promise<boolean> {
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }
}

/** In-memory implementation for tests. */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const sha256 = sha256Hex(bytes);
    if (!this.blobs.has(sha256)) this.blobs.set(sha256, new Uint8Array(bytes));
    return { sha256, bytes: bytes.byteLength, mediaType };
  }

  async get(sha256: Sha256Hex): Promise<Uint8Array> {
    const data = this.blobs.get(sha256);
    if (!data) throw new BlobNotFoundError(sha256);
    return data;
  }

  async has(sha256: Sha256Hex): Promise<boolean> {
    return this.blobs.has(sha256);
  }
}
