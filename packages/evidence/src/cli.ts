/**
 * Offline evidence tools over the blob store under `OLCYS_DATA_DIR` (default `./data`):
 *   node packages/evidence/src/cli.ts verify <sha256>
 *   node packages/evidence/src/cli.ts export <dir> <sha256...>
 */
import { join } from 'node:path';
import { FileBlobStore } from './blob-store.ts';
import { writeCollectionPackage } from './collection-package.ts';
import { verifyCapture } from './verify-capture.ts';

const USAGE = 'Użycie: cli.ts verify <sha256> | export <katalog> <sha256…>';
const SHA256 = /^[0-9a-f]{64}$/;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const blobs = new FileBlobStore(join(process.env['OLCYS_DATA_DIR'] ?? './data', 'blobs'));
  if (command === 'verify' && rest.length === 1 && SHA256.test(rest[0] ?? '')) {
    const result = await verifyCapture(rest[0]!, blobs);
    console.log(`manifest: ${result.manifest}`);
    for (const a of result.artifacts) console.log(`${a.result}\t${a.kind}\t${a.sha256}`);
    console.log(result.ok ? 'WYNIK: zgodne' : 'WYNIK: NIEZGODNE');
    return result.ok ? 0 : 1;
  }
  if (command === 'export' && rest.length >= 2 && rest.slice(1).every((d) => SHA256.test(d))) {
    const { files } = await writeCollectionPackage(rest.slice(1), rest[0]!, blobs);
    console.log(`Zapisano ${files.length} plików w ${rest[0]}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
