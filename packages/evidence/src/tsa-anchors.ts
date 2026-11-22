/** Trust anchors of the time-stamp authority: PEM certificates committed in the repository, read from local files. */
import { readFile } from 'node:fs/promises';
import * as pkijs from 'pkijs';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g;

export function pemToDer(pem: string): Uint8Array<ArrayBuffer>[] {
  return [...pem.matchAll(PEM_BLOCK)].map((m) =>
    Uint8Array.from(Buffer.from((m[1] ?? '').replace(/\s+/g, ''), 'base64')),
  );
}

export function parseCertificates(pems: readonly string[]): pkijs.Certificate[] {
  return pems.flatMap((pem) => pemToDer(pem).map((der) => pkijs.Certificate.fromBER(der)));
}

/** Reads the PEM files; each must hold at least one parseable certificate (a missing anchor must not pass silently). */
export async function loadTrustAnchors(paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) throw new Error('no TSA trust anchors configured');
  return Promise.all(
    paths.map(async (path) => {
      const pem = await readFile(path, 'utf8');
      if (parseCertificates([pem]).length === 0) throw new Error(`no certificate found in ${path}`);
      return pem;
    }),
  );
}
