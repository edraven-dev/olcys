/**
 * Reads the committed corpus (`fixtures/corpus/`): manifest, rendered documents and ground truth grouped per
 * document. Verifies the manifest hashes on request. Secrets stay placeholders here (see `secrets.ts`).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CorpusManifest, TruthRow } from './types.ts';

/** `fixtures/corpus` of this repository. */
export const DEFAULT_CORPUS_DIR = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'corpus');

export type DocType = 'html' | 'txt' | 'json';

export interface CorpusDocument {
  docId: string;
  lang: string;
  template: string;
  type: DocType;
  path: string;
  /** As stored (secret placeholders unfilled). */
  text: string;
  truth: TruthRow[];
}

export interface LoadedCorpus {
  dir: string;
  manifest: CorpusManifest;
  documents: CorpusDocument[];
}

const DOC_PATH = /^docs\/((pl|en)-([a-z0-9-]+)-\d{3})\.(html|txt|json)$/;

export async function loadCorpus(dir = DEFAULT_CORPUS_DIR): Promise<LoadedCorpus> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CorpusManifest;
  const truth = (await readFile(join(dir, 'ground-truth.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TruthRow);
  const byDoc = new Map<string, TruthRow[]>();
  for (const row of truth) byDoc.set(row.docId, [...(byDoc.get(row.docId) ?? []), row]);
  const documents: CorpusDocument[] = [];
  for (const path of Object.keys(manifest.files).toSorted()) {
    const match = DOC_PATH.exec(path);
    if (!match) continue;
    const [, docId = '', lang = '', template = '', type] = match;
    // oxlint-disable-next-line no-await-in-loop
    const text = await readFile(join(dir, path), 'utf8');
    documents.push({ docId, lang, template, type: type as DocType, path, text, truth: byDoc.get(docId) ?? [] });
  }
  return { dir, manifest, documents };
}

/** Paths whose SHA-256 differs from the manifest (or that are missing). */
export async function verifyManifest(dir = DEFAULT_CORPUS_DIR): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CorpusManifest;
  const bad: string[] = [];
  for (const [path, hash] of Object.entries(manifest.files)) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(dir, path), 'utf8');
      if (createHash('sha256').update(text).digest('hex') !== hash) bad.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bad.push(`${path} (missing)`);
    }
  }
  return bad;
}
