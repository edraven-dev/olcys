/** Scans the committed fixture tree: synthetic markers, no real hosts, robots canary and decoy placement. */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonaManifest } from '../src/manifest.ts';
import { check, pathsFor } from '../scripts/generate.ts';
import { verifyBip137 } from '../scripts/lib/crypto.ts';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..', '..');

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

let manifest: PersonaManifest;
const tree = new Map<string, string>();

beforeAll(async () => {
  manifest = JSON.parse(await readFile(join(REPO, 'fixtures/persona/manifest.json'), 'utf8')) as PersonaManifest;
  const paths = (
    await Promise.all([join(APP, 'templates'), join(APP, 'public'), join(REPO, 'fixtures/persona')].map(files))
  ).flat();
  const texts = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
  paths.forEach((file, index) => tree.set(relative(REPO, file), texts[index] ?? ''));
});

describe('committed fixtures', () => {
  it('are in sync with the manifest (generate --check)', async () => {
    expect(await check(pathsFor())).toEqual([]);
  });

  it('mark every HTML page and JSON document as synthetic', () => {
    const entries = [...tree];
    const unmarkedHtml = entries
      .filter(([path]) => path.endsWith('.html'))
      .filter(([, text]) => !text.includes('DANE SYNTETYCZNE') || !text.includes('noindex,nofollow'))
      .map(([path]) => path);
    const unmarkedJson = entries
      .filter(([path]) => path.endsWith('.json') && path.includes('/public/'))
      .filter(([, text]) => {
        const doc = JSON.parse(text) as unknown;
        const items: unknown[] = Array.isArray(doc) ? doc : [doc];
        return items.some((item) => typeof item !== 'object' || item === null || !('_synthetic' in item));
      })
      .map(([path]) => path);
    expect(unmarkedHtml).toEqual([]);
    expect(unmarkedJson).toEqual([]);
  });

  it('link only to the fixture site itself or example.org', () => {
    for (const [path, text] of tree) {
      for (const match of text.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const target = match[1] ?? '';
        if (target.startsWith('/') || target.startsWith('index.php') || target.startsWith('#')) continue;
        expect([path, target]).toEqual([
          path,
          expect.stringMatching(/^(https:\/\/example\.org\/|mailto:[^@]+@example\.org$)/),
        ]);
      }
      for (const email of text.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) {
        if (email[1]?.includes('example.org')) continue;
        expect([path, email[0]]).toEqual([path, 'an e-mail at example.org']);
      }
      expect([
        path,
        /\b(xprv|xpub)[1-9A-HJ-NP-Za-km-z]{20,}/.test(text) || /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/.test(text),
      ]).toEqual([path, false]);
    }
  });

  it('keep the robots canary on the disallowed page only', () => {
    const canary = manifest.addresses['BTC-CANARY']!.address;
    const hits = [...tree]
      .filter(([path, text]) => text.includes(canary) && !path.endsWith('manifest.json'))
      .map(([path]) => path);
    expect(hits).toEqual(['apps/fixture-site/public/shared/private/index.html']);
    expect(tree.get('apps/fixture-site/public/shared/robots.txt')).toMatch(
      /User-agent: OLCYS\nDisallow: \/private\/[\s\S]*User-agent: \*\nDisallow: \/private\//,
    );
  });

  it('place the decoys where the manifest says', () => {
    const topic = tree.get('apps/fixture-site/public/shared/bitcointalk/topic-5500002.html') ?? '';
    const post = (id: string) =>
      topic.slice(
        topic.indexOf(`name="msg${id}"`),
        topic.indexOf('</table>\n        <a name', topic.indexOf(`name="msg${id}"`)),
      );
    expect(post('65000101')).toContain(manifest.addresses['TX-DECOY']!.address);
    expect(post('65000102')).toContain(`portfel gorący: ${manifest.addresses['HOT-1']!.address}`);
    expect(post('65000103')).toMatch(new RegExp(`<div class="code">${manifest.addresses['D2']!.address}</div>`));
    expect(topic.slice(topic.indexOf('name="msg65000104"'))).toContain(manifest.addresses['CONTRACT-1']!.address);
    expect(tree.get('apps/fixture-site/public/shared/telegram/s/olcys_test_ostrzezenia/index.html')).toContain(
      manifest.addresses['D3']!.address,
    );
    const docVectors = [...tree].filter(([, text]) => text.includes('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'));
    expect(docVectors.every(([path]) => /topic-5500002|showposts-900001|manifest\.json/.test(path))).toBe(true);
  });

  it('carry valid committed signatures and test vectors', async () => {
    const sig = manifest.signedMessages[0]!;
    expect(verifyBip137(manifest.addresses['BTC-1']!.address, sig.message, sig.signature)).toBe('valid');
    expect(tree.get('apps/fixture-site/public/shared/bitcointalk/topic-5500001.html')).toContain(sig.signature);
    const { vectors } = JSON.parse(await readFile(join(REPO, 'fixtures/persona/test-vectors.json'), 'utf8')) as {
      vectors: {
        id: string;
        address: string;
        message: string;
        signature: string;
        expected: string;
        normalise?: string;
      }[];
    };
    const outcomes = vectors.map((v) => [
      v.id,
      verifyBip137(v.address, v.normalise ? v.message.replaceAll('\r\n', '\n') : v.message, v.signature),
    ]);
    expect(outcomes).toEqual(vectors.map((v) => [v.id, v.expected]));
  });

  it('serve from src/ with Node built-ins only (no node_modules in the container)', async () => {
    for (const file of await files(join(APP, 'src'))) {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/^import .* from '([^']+)';$/gm)) {
        expect([file, match[1]]).toEqual([file, expect.stringMatching(/^(node:|\.\/)/)]);
      }
    }
  });
});
