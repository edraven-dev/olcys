/**
 * Relation accuracy on the synthetic extraction corpus (`fixtures/corpus/`): every document is extracted with the
 * address extractor, wrapped in a synthetic anchored account and turned into claims with `buildClaims`; the relation
 * of each labelled address is compared with the relation its truth role must lead to. Reads files only (no network).
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTRACTOR_VERSION, extractCapture, parseDenyList, type CaptureContent } from '@olcys/address-extractor';
import { type ArtifactKind, type Capture, type Relation, type RoleCue } from '@olcys/core';
import { buildClaims, expectedRelation, type RelationPair, type ScoringWeights } from '../../src/index.ts';

interface TruthRow {
  docId: string;
  canonical?: string;
  expected: string;
  role: RoleCue | 'none';
}

export interface CorpusRelations {
  pairs: RelationPair[];
  /** Labelled addresses without a claim (not extracted, filtered or without an unambiguous truth role). */
  unmatched: number;
  extractorVersion: string;
}

const MEDIA: Record<string, { kind: ArtifactKind; mediaType: string }> = {
  html: { kind: 'html', mediaType: 'text/html; charset=utf-8' },
  txt: { kind: 'text', mediaType: 'text/plain; charset=utf-8' },
  json: { kind: 'json', mediaType: 'application/json' },
};

const AT = '2026-11-21T10:00:00.000Z';
const id = (prefix: string, n: number): string => `0190${prefix}0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** `true` when `dir` looks like the corpus (ground truth and a documents directory). */
export function corpusPresent(dir: string): boolean {
  return existsSync(join(dir, 'ground-truth.jsonl')) && existsSync(join(dir, 'docs'));
}

/**
 * Claims-level relation accuracy of the corpus. `limit` caps the number of documents (the first ones by id).
 * Secret placeholders stay unfilled; they are neither addresses nor keys.
 */
export async function corpusRelations(
  dir: string,
  w: ScoringWeights,
  denyListYaml: string,
  options: { limit?: number } = {},
): Promise<CorpusRelations> {
  const denyList = parseDenyList(denyListYaml);
  const rows = (await readFile(join(dir, 'ground-truth.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TruthRow);
  const byDoc = new Map<string, TruthRow[]>();
  for (const row of rows) byDoc.set(row.docId, [...(byDoc.get(row.docId) ?? []), row]);
  const files = (await readdir(join(dir, 'docs'))).toSorted().slice(0, options.limit);

  const pairs: RelationPair[] = [];
  let unmatched = 0;
  let counter = 0;
  for (const [index, file] of files.entries()) {
    const dot = file.lastIndexOf('.');
    const docId = file.slice(0, dot);
    const media = MEDIA[file.slice(dot + 1)] ?? { kind: 'text' as const, mediaType: 'text/plain; charset=utf-8' };
    const truth = new Map<string, Set<Relation>>();
    for (const row of byDoc.get(docId) ?? []) {
      if (row.expected !== 'positive' || !row.canonical) continue;
      const key = row.canonical.toLowerCase();
      truth.set(key, (truth.get(key) ?? new Set()).add(expectedRelation(row.role)));
    }
    if (truth.size === 0) continue;

    // oxlint-disable-next-line no-await-in-loop
    const bytes = new Uint8Array(await readFile(join(dir, 'docs', file)));
    const captureId = id('c', index + 1);
    const url = `https://example.org/corpus/${docId}`;
    const content: CaptureContent = {
      captureId,
      url,
      finalUrl: url,
      artifacts: [{ kind: media.kind, mediaType: media.mediaType, bytes }],
    };
    // oxlint-disable-next-line no-await-in-loop
    const extraction = await extractCapture(content, { denyList, newId: () => id('a', (counter += 1)) });
    const capture: Capture = {
      id: captureId,
      runId: 'run-corpus',
      sourceId: 'fixture_site',
      url,
      finalUrl: url,
      collectedAt: AT,
      collector: 'calibration',
      clockSynced: true,
      toolVersion: EXTRACTOR_VERSION,
      userAgent: 'calibration',
      httpStatus: 200,
      status: 'ok',
      artifacts: [],
      manifestSha256: '0'.repeat(64),
      fetchIds: [],
    };
    const { claims } = buildClaims(
      {
        runId: 'run-corpus',
        identifiers: [
          {
            id: 'idf-corpus',
            caseId: 'case-corpus',
            kind: 'nickname',
            value: 'fikcyjny_korpus',
            platform: 'corpus',
            isAnchor: true,
            addedAt: AT,
            addedBy: 'calibration',
          },
        ],
        accounts: [
          {
            id: 'acc-corpus',
            runId: 'run-corpus',
            platform: 'corpus',
            handle: 'fikcyjny_korpus',
            profileUrl: 'https://example.org/corpus/profile',
            discoveredVia: { sourceId: 'fixture_site', method: 'input', captureId },
          },
        ],
        captures: [capture],
        observations: [],
        extractions: [extraction],
        sources: () => undefined,
        exclusions: [],
      },
      w,
    );
    for (const [address, relations] of truth) {
      const claim = claims.find((c) => c.address.address.toLowerCase() === address);
      const [only] = [...relations];
      if (!claim || relations.size !== 1 || !only) {
        unmatched += 1;
        continue;
      }
      pairs.push({ truth: only, predicted: claim.relation });
    }
  }
  return { pairs, unmatched, extractorVersion: EXTRACTOR_VERSION };
}
