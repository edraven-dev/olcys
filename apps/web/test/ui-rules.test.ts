/**
 * Guards for two project rules: every user-visible string lives in `src/i18n/pl.ts`, and the console never
 * references an external host (no CDN, fonts, analytics or links to third-party sites).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(tsx?|css|html)$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(SRC, f), 'utf8') }));
const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

const LETTER = /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/;

describe('UI copy comes from the catalogue', () => {
  it('has no text literals in JSX', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.name.endsWith('.tsx'))) {
      // JSX text between a closing `>` and the next `<` or `{`, ignoring arrow functions and comparisons.
      for (const match of file.text.matchAll(/(?<![=-])>([^<>{}\n]*)(?=[<{])/g)) {
        const text = match[1]?.trim() ?? '';
        if (LETTER.test(text) && !/[;=()]/.test(text)) offenders.push(`${file.name}: ${text}`);
      }
      for (const match of file.text.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
        if (LETTER.test(match[2] ?? '')) offenders.push(`${file.name}: ${match[1]}="${match[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps Polish text out of code outside the catalogue', () => {
    const polish = /[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/;
    const offenders = files
      .filter((f) => !f.name.includes('i18n') && /\.tsx?$/.test(f.name))
      .flatMap((f) =>
        f.text
          .split('\n')
          .filter((line) => polish.test(line) && !/^(\/\/|\/\*|\*)/.test(line.trim()))
          .map((line) => `${f.name}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe('no external resources', () => {
  it('references no absolute http(s) URL in sources or index.html', () => {
    const offenders = [...files, { name: 'index.html', text: indexHtml }].flatMap((f) =>
      [...f.text.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => `${f.name}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('calls only its own API', () => {
    const calls = files.flatMap((f) => [...f.text.matchAll(/fetch\(([^)]*)\)/g)].map((m) => `${f.name}: ${m[1]}`));
    expect(calls).toEqual(['lib/api.ts: input, init']);
  });
});
