import {
  ADMIRALTY_RELIABILITY,
  RELATIONS,
  type AdmiraltyReliability,
  type EvidenceFeature,
  type Relation,
} from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { scoreLink, type ClaimInput, type PathInput } from '../link.ts';
import { RELATION_RULES_VERSION } from '../version.ts';
import type { ScoringWeights } from '../weights.ts';

/** One engine-level persona claim with the score the demo (and the methodology's worked example) expects. */
export interface PersonaCase {
  id: string;
  expected: number;
  relation: Relation;
  paths: PathInput[];
}

export interface PersonaResult {
  claim: string;
  expected: number;
  got: number;
}

function fail(message: string): never {
  throw new Error(`persona set: ${message}`);
}

function items(raw: unknown, hop: 'identity' | 'address', group: string, where: string): EvidenceFeature[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail(`${where} must be a list`);
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e['feature'] !== 'string') return fail(`${where}[${i}].feature must be a string`);
    if (!(ADMIRALTY_RELIABILITY as readonly unknown[]).includes(e['grade']))
      return fail(`${where}[${i}].grade is invalid`);
    return {
      hop,
      feature: e['feature'],
      reliability: e['grade'] as AdmiraltyReliability,
      originGroup: typeof e['originGroup'] === 'string' ? e['originGroup'] : group,
      evidence: {},
    };
  });
}

/** Parses `fixtures/calibration/persona.v1.yaml`. Throws `Error` on a schema problem. */
export function parsePersonaSet(text: string): { version: string; cases: PersonaCase[] } {
  const doc = parseYaml(text, { uniqueKeys: true }) as Record<string, unknown> | null;
  if (!doc || typeof doc['version'] !== 'string') return fail('`version` is required');
  const list = doc['cases'];
  if (!Array.isArray(list) || list.length === 0) return fail('`cases` must be a non-empty list');
  const cases = list.map((raw, i): PersonaCase => {
    const c = raw as Record<string, unknown>;
    const at = `cases[${i}]`;
    if (typeof c['id'] !== 'string') return fail(`${at}.id must be a string`);
    if (typeof c['expected'] !== 'number') return fail(`${at}.expected must be a number`);
    if (!(RELATIONS as readonly unknown[]).includes(c['relation'])) return fail(`${at}.relation is invalid`);
    if (!Array.isArray(c['paths']) || c['paths'].length === 0) return fail(`${at}.paths must be a non-empty list`);
    const paths = c['paths'].map((rawPath, j): PathInput => {
      const p = rawPath as Record<string, unknown>;
      const where = `${at}.paths[${j}]`;
      if (typeof p['service'] !== 'string' || typeof p['originGroup'] !== 'string') {
        return fail(`${where} needs service and originGroup`);
      }
      return {
        anchor: p['anchor'] === true,
        service: p['service'],
        originGroup: p['originGroup'],
        identity: items(p['identity'], 'identity', p['originGroup'], `${where}.identity`),
        address: items(p['address'], 'address', p['originGroup'], `${where}.address`),
      };
    });
    return { id: c['id'], expected: c['expected'], relation: c['relation'] as Relation, paths };
  });
  return { version: doc['version'], cases };
}

/** Scores the persona claims with the engine; the caller compares `got` with `expected`. */
export function scorePersona(cases: readonly PersonaCase[], w: ScoringWeights): PersonaResult[] {
  return cases.map((c) => {
    const claim: ClaimInput = {
      runId: 'calibration-persona',
      identityId: 'calibration-subject',
      address: { chain: 'bitcoin', address: `persona-${c.id}` },
      relation: c.relation,
      tier: 'E3',
      checksum: { scheme: 'none', present: false, valid: true, bits: 0 },
      paths: c.paths,
      exclusions: [],
      reviewRequired: false,
      rulesVersion: RELATION_RULES_VERSION,
    };
    const result = scoreLink(claim, w, {
      clock: { now: () => new Date('2026-11-21T12:00:00.000Z') },
      newId: () => '01900000-0000-7000-8000-000000000000',
    });
    if (!result.ok) throw new Error(`persona claim ${c.id} could not be scored: ${result.reason}`);
    return { claim: c.id, expected: c.expected, got: result.assessment.score };
  });
}
