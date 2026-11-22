import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustAnchors, parseCertificates, pemToDer } from '../src/index.ts';

const DIR = join(import.meta.dirname, '..', '..', '..', 'config', 'tsa', 'freetsa');
const fingerprint = (der: Uint8Array): string =>
  createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)?.join(':') ?? '';

describe('committed FreeTSA trust anchors', () => {
  it.each([
    ['cacert.pem', 'A6:37:9E:7C:EC:C0:5F:AA:3C:BF:07:60:13:D7:45:E3:27:BB:BA:A3:8C:0B:9A:F2:24:69:D4:70:1D:18:AA:BC'],
    ['tsa.crt', '32:E8:41:A9:5C:C1:16:41:01:FF:DE:41:29:8E:F2:FC:75:C1:C4:37:2E:F0:95:E8:8A:6B:BD:47:DF:B1:91:FC'],
  ])('%s has the documented SHA-256 fingerprint', async (file, expected) => {
    const pem = await readFile(join(DIR, file), 'utf8');
    const [der] = pemToDer(pem);
    expect(der && fingerprint(der)).toBe(expected);
    expect(pem).not.toContain('PRIVATE KEY');
    expect(parseCertificates([pem])).toHaveLength(1);
  });

  it('loadTrustAnchors reads the files and refuses empty input or a file without a certificate', async () => {
    expect(await loadTrustAnchors([join(DIR, 'cacert.pem')])).toHaveLength(1);
    await expect(loadTrustAnchors([])).rejects.toThrow('no TSA trust anchors');
    await expect(loadTrustAnchors([join(DIR, 'README.md')])).rejects.toThrow('no certificate');
  });
});
