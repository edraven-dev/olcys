/**
 * The final secret guard: a planted bug that copies a secret into a candidate snippet must make the extraction throw
 * `SecretLeakError` instead of returning a result.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDenyList } from '../src/deny-list.ts';
import { gen, htmlCapture } from './helpers.ts';

vi.mock('../src/context/context.ts', async (original) => {
  const actual = await original<typeof import('../src/context/context.ts')>();
  return {
    ...actual,
    buildContext: (...args: Parameters<typeof actual.buildContext>) => {
      const context = actual.buildContext(...args);
      // The planted bug: the raw secret (read back from the view text) ends up in the snippet.
      const view = args[1];
      const at = view.text.indexOf('klucz prywatny: ');
      return { ...context, snippet: `${context.snippet} ${view.text.slice(at + 16, at + 16 + 64)}` };
    },
  };
});

const { extractCapture, SecretLeakError } = await import('../src/extract.ts');
const denyList = parseDenyList(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'config/rules/deny-list.v1.yaml'), 'utf8'),
);

describe('secret guard', () => {
  it('throws SecretLeakError when a secret is copied into a snippet', async () => {
    const html = `<p>Portfel: ${gen.p2wpkh('guard')}<br>klucz prywatny: ${gen.hex64('guard-hex')}</p>`;
    await expect(extractCapture(htmlCapture(html), { denyList })).rejects.toBeInstanceOf(SecretLeakError);
  });
});
