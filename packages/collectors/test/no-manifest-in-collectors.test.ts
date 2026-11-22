import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('capture manifests', () => {
  it('are computed only by the capture recorder, never by collector code', async () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith('.ts')) continue;
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(root, entry), 'utf8');
      if (/manifestSha256|capture-manifest/.test(text)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
