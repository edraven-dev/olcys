import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ArtifactKind, BlobStore, Sha256Hex } from '@olcys/core';
import { ArtifactIntegrityError } from './capture-manifest.ts';
import { sha256Hex } from './blob-store.ts';
import { readChecked, readManifest } from './verify-capture.ts';

const EXTENSIONS: Record<string, string> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/json': 'json',
  'text/plain': 'txt',
  'image/png': 'png',
  'application/warc': 'warc',
};

function extensionFor(kind: ArtifactKind, mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[base] ?? (kind === 'json' || kind === 'headers' ? 'json' : 'bin');
}

/** The output directory already holds files: a package must not be mixed with an earlier one. */
export class OutputDirectoryNotEmptyError extends Error {
  constructor() {
    super('output directory is not empty');
    this.name = 'OutputDirectoryNotEmptyError';
  }
}

export const READ_ME_FILE = 'CZYTAJ_MNIE.txt';

const READ_ME = `PACZKA ZABEZPIECZONEGO MATERIAŁU (OŁCyŚ)

Zawartość:
  manifests/<id>.json            manifest przechwycenia (kanoniczny JSON, RFC 8785)
  artifacts/<id>/<rodzaj>-<12 znaków skrótu>.<rozszerzenie>
                                 zabezpieczone pliki: treść strony, nagłówki odpowiedzi itd.
  SHA256SUMS                     skróty SHA-256 wszystkich plików paczki (format polecenia sha256sum)
  CZYTAJ_MNIE.txt                ta instrukcja

Jak sprawdzić paczkę:
  1. W katalogu paczki uruchom:  sha256sum -c SHA256SUMS
     Każdy wiersz powinien kończyć się wynikiem OK.
  2. Skrót SHA-256 pliku manifests/<id>.json jest skrótem manifestu cytowanym w rejestrze dowodów i raporcie:
     sha256sum manifests/<id>.json
  3. Manifest wymienia skróty wszystkich zabezpieczonych plików (pole "artifacts") oraz rodzaje plików, których
     brakuje (pole "completeness.missing"). Skróty z manifestu powinny zgadzać się ze skrótami plików w artifacts/.

Co potwierdza skrót: że plik jest bajt w bajt taki, jaki zabezpieczono w chwili pobrania. Nie potwierdza, że treść
strony była prawdziwa ani że dana osoba jest jej autorem. Czas i tożsamość kolekcjonera pochodzą z manifestu
(pola "time" i "collector"); zegar jest wiarygodny tylko wtedy, gdy manifest wskazuje "time.clock.synced": true.

Manifest zawiera nazwę analityka i adres IP stanowiska: traktuj paczkę jako materiał o ograniczonym dostępie.
`;

/**
 * Writes a self-contained collection package for the given manifests: the manifest bytes, every artifact (re-hashed
 * while copying), a sorted `SHA256SUMS` and a Polish `CZYTAJ_MNIE.txt`. Returns the relative paths written.
 */
export async function writeCollectionPackage(
  manifestSha256s: Sha256Hex[],
  outDir: string,
  blobs: BlobStore,
): Promise<{ files: string[] }> {
  const root = resolve(outDir);
  const existing = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) throw new OutputDirectoryNotEmptyError();
  const sums = new Map<string, Sha256Hex>();
  const put = async (relative: string, bytes: Uint8Array): Promise<void> => {
    const target = resolve(outDir, relative);
    // Names come from stored manifests: never write outside the package directory.
    if (!target.startsWith(root + sep)) throw new Error(`refusing to write outside the package directory: ${relative}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    sums.set(relative, sha256Hex(bytes));
  };

  for (const digest of manifestSha256s) {
    // oxlint-disable-next-line no-await-in-loop
    const loaded = await readManifest(digest, blobs);
    if ('problem' in loaded)
      throw new ArtifactIntegrityError(digest, loaded.problem === 'missing' ? 'missing' : 'digest_mismatch');
    const { manifest } = loaded;
    // oxlint-disable-next-line no-await-in-loop
    await put(`manifests/${manifest.captureId}.json`, loaded.bytes);
    for (const artifact of manifest.artifacts) {
      const relative = `artifacts/${manifest.captureId}/${artifact.kind}-${artifact.sha256.slice(0, 12)}.${extensionFor(artifact.kind, artifact.mediaType)}`;
      if (sums.has(relative)) continue;
      // oxlint-disable-next-line no-await-in-loop
      const check = await readChecked(blobs, artifact.sha256);
      if (check.result !== 'ok') throw new ArtifactIntegrityError(artifact.sha256, check.result);
      // oxlint-disable-next-line no-await-in-loop
      await put(relative, check.bytes);
    }
  }

  await put(READ_ME_FILE, new TextEncoder().encode(READ_ME));
  const lines = [...sums.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, sha]) => `${sha}  ${path}`);
  await writeFile(join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return { files: [...sums.keys(), 'SHA256SUMS'].toSorted() };
}
