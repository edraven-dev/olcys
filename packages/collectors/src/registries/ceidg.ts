/**
 * CEIDG API v3 (official register of sole proprietorships; the only official API that searches by first and last
 * name). A search by name returns every namesake, so the collector records how many firms matched
 * (`registry.ceidg.result_count`) and the planner follows a NIP only when exactly one did. Live runs need the
 * institution's own token (`CEIDG_API_TOKEN`, sent as a Bearer header that is never logged or recorded); offline and
 * replay talk to the synthetic fixture site and need none.
 */
import type { Capture, CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { sha256Hex } from '../framework/capture.ts';
import { usesFixtures } from '../framework/urls.ts';
import { asArray, asObject, asText, joinText, registryFetch, type Json } from './common.ts';
import { isValidNip, normalizeNip, splitPolishFullName } from './polish-ids.ts';

export const CEIDG_SOURCE_ID = 'ceidg';
export const CEIDG_BASE_URL = 'https://dane.biznes.gov.pl/api/ceidg/v3';
export const CEIDG_DEFAULT_MAX_RESULTS = 25;
export const CEIDG_PARSER_VERSION = 'ceidg-v3.v1';
const SOFTWARE = [{ name: 'parser:ceidg', version: CEIDG_PARSER_VERSION }];

export interface CeidgOptions {
  /** `CEIDG_API_TOKEN`; required in live mode, ignored offline and in replay. */
  token?: string | undefined;
  baseUrl?: string;
  /** Page size of a search (default 25); namesakes beyond it are counted, not read. */
  maxResults?: number;
  /** Also read the firm's details page for a single match (business e-mail and website). Default false: one request. */
  fetchDetails?: boolean;
}

type Target = { kind: 'name'; imie: string; nazwisko: string } | { kind: 'nip'; nip: string };

/** Observation subject of one search: `ceidg-search:<sha256 of "imie nazwisko">` (the name itself stays out of keys). */
export function ceidgSearchKey(target: Target): string {
  return `ceidg-search:${sha256Hex(target.kind === 'name' ? `${target.imie} ${target.nazwisko}` : `nip ${target.nip}`)}`;
}

/** Request URL of a search; array parameters as in the CEIDG v3 documentation, UTF-8 percent-encoded. */
export function ceidgSearchUrl(baseUrl: string, target: Target, limit: number): string {
  const params = new URLSearchParams();
  if (target.kind === 'name') {
    params.append('imie[]', target.imie);
    params.append('nazwisko[]', target.nazwisko);
  } else {
    params.append('nip[]', target.nip);
  }
  params.set('page', '1');
  params.set('limit', String(limit));
  return `${baseUrl.replace(/\/+$/, '')}/firmy?${params.toString()}`;
}

/** Business address as one line; CEIDG sends an object (or, in older shapes, a string). */
export function formatCeidgAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return asText(value);
  const a = asObject(value);
  if (!a) return undefined;
  const house = joinText([asText(a['budynek']), asText(a['lokal']) ? `/${asText(a['lokal'])}` : undefined], '');
  const street = joinText([asText(a['ulica']), house]);
  const town = joinText([asText(a['kod']), asText(a['miasto'])]);
  return joinText([street, town], ', ');
}

function targetsOf(input: CollectorInput): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (target: Target): void => {
    const key = ceidgSearchKey(target);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  for (const value of input.values ?? []) {
    const nip = value.kind === 'nip' ? normalizeNip(value.value) : undefined;
    if (nip && isValidNip(nip)) add({ kind: 'nip', nip });
  }
  for (const identifier of input.identifiers) {
    if (identifier.kind !== 'full_name') continue;
    const name = splitPolishFullName(identifier.value);
    if (name) add({ kind: 'name', ...name });
  }
  return targets;
}

function firmsOf(json: unknown): Json[] {
  return asArray(asObject(json)?.['firmy']).flatMap((f) => {
    const firm = asObject(f);
    return firm ? [firm] : [];
  });
}

export function createCeidgCollector(options: CeidgOptions = {}): CollectorFactory {
  const baseUrl = options.baseUrl ?? CEIDG_BASE_URL;
  const maxResults = options.maxResults ?? CEIDG_DEFAULT_MAX_RESULTS;
  return {
    sourceId: CEIDG_SOURCE_ID,
    platform: CEIDG_SOURCE_ID,
    identifierKinds: ['full_name'],
    create(descriptor, deps): SourceCollector {
      const fixtures = usesFixtures(deps.mode);
      const token = options.token?.trim();
      const available = (): boolean => fixtures || !!token;
      return {
        descriptor,
        supports: (input) => available() && targetsOf(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const targets = available() ? targetsOf(input) : [];
          if (!targets.length) {
            rb.note('unsupported_input', available() ? 'no full name with a first and last name' : 'no CEIDG token');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const target of targets) {
            if (http.stopped()) break;
            if (deps.mode === 'live' && refusesSynthetic(target, deps.config.syntheticIdentifiers)) {
              rb.note('synthetic_identifier_refused', 'the name is a synthetic test identifier');
              rb.addStatus('error');
              continue;
            }
            // Sequential on purpose: one request at a time per source (1 request / 4 s).
            // oxlint-disable-next-line no-await-in-loop
            await search(http, rb, target, {
              baseUrl,
              maxResults,
              token: fixtures ? undefined : token,
              fetchDetails: options.fetchDetails === true,
            });
          }
          return rb.build();
        },
      };
    },
  };
}

function refusesSynthetic(target: Target, synthetic: readonly string[]): boolean {
  const text = target.kind === 'name' ? `${target.imie} ${target.nazwisko}` : target.nip;
  return synthetic.some((s) => s.trim().toLowerCase() === text.toLowerCase());
}

async function search(
  http: SourceHttp,
  rb: ResultBuilder,
  target: Target,
  options: { baseUrl: string; maxResults: number; token: string | undefined; fetchDetails: boolean },
): Promise<void> {
  const answer = await registryFetch(http, {
    url: ceidgSearchUrl(options.baseUrl, target, options.maxResults),
    purpose: 'ceidg firm search',
    // Redacted by the egress client by default; named here so it holds for any configuration.
    ...(options.token
      ? { headers: { authorization: `Bearer ${options.token}` }, secretParams: ['authorization'] }
      : {}),
    software: SOFTWARE,
    classify: (json, httpStatus) =>
      httpStatus >= 200 && httpStatus < 300 && !firmsOf(json).length
        ? { status: 'not_found', reason: 'CEIDG returned no firm for the search' }
        : undefined,
  });
  rb.addPage({ status: answer.status, ...(answer.capture ? { capture: answer.capture } : {}), notes: answer.notes });
  if (answer.status === 'not_found') rb.affirmNotFound('no matching firm in CEIDG');
  if (answer.status !== 'ok' || !answer.capture) return;
  const firms = firmsOf(answer.json);
  const reported = asObject(answer.json)?.['count'];
  const count = Math.max(firms.length, typeof reported === 'number' && Number.isInteger(reported) ? reported : 0);
  const searchKey = ceidgSearchKey(target);
  rb.observe(
    answer.capture,
    { type: 'page', key: searchKey },
    'registry.ceidg.result_count',
    String(count),
    `${searchKey}#count`,
  );
  if (count > firms.length) rb.note('truncated', `${count} firms matched, first ${firms.length} read`);
  const capture = answer.capture;
  const emitted: { key: string; id: string | undefined }[] = [];
  firms.forEach((firm, i) => {
    const owner = asObject(firm['wlasciciel']);
    const id = asText(firm['id']);
    const nip = asText(owner?.['nip']);
    const key = `ceidg:${id ?? nip ?? `result-${i + 1}`}`;
    const at = (path: string): string => `${key}#firmy[${i}].${path}`;
    const subject = { type: 'page' as const, key };
    const fact = (property: string, value: string | undefined, path: string): void => {
      if (value) rb.observe(capture, subject, property, value, at(path));
    };
    fact('registry.business_name', asText(firm['nazwa']), 'nazwa');
    fact('registry.owner_name', joinText([asText(owner?.['imie']), asText(owner?.['nazwisko'])]), 'wlasciciel');
    fact('registry.nip', nip ? normalizeNip(nip) : undefined, 'wlasciciel.nip');
    fact('registry.regon', asText(owner?.['regon']), 'wlasciciel.regon');
    fact('registry.status', asText(firm['status']), 'status');
    fact('registry.business_location', formatCeidgAddress(firm['adresDzialalnosci']), 'adresDzialalnosci');
    fact('registry.start_date', asText(firm['dataRozpoczecia']), 'dataRozpoczecia');
    fact('registry.removal_date', asText(firm['dataZakonczenia']), 'dataZakonczenia');
    emitted.push({ key, id });
  });
  // Contact data (business e-mail and website, only when the entrepreneur published them) for an unambiguous hit.
  const only = options.fetchDetails && emitted.length === 1 && count === 1 ? emitted[0] : undefined;
  if (only?.id && !http.stopped()) await contact(http, rb, options, only.key, only.id);
}

async function contact(
  http: SourceHttp,
  rb: ResultBuilder,
  options: { baseUrl: string; token: string | undefined },
  key: string,
  id: string,
): Promise<void> {
  const answer = await registryFetch(http, {
    url: `${options.baseUrl.replace(/\/+$/, '')}/firma/${encodeURIComponent(id)}`,
    purpose: 'ceidg firm details',
    ...(options.token
      ? { headers: { authorization: `Bearer ${options.token}` }, secretParams: ['authorization'] }
      : {}),
    software: SOFTWARE,
  });
  rb.addPage({ status: answer.status, ...(answer.capture ? { capture: answer.capture } : {}), notes: answer.notes });
  if (answer.status !== 'ok' || !answer.capture) return;
  const root = asObject(answer.json);
  const firm = asObject(asArray(root?.['firma'])[0]) ?? root;
  const capture: Capture = answer.capture;
  const subject = { type: 'page' as const, key };
  const www = asText(firm?.['www']);
  const email = asText(firm?.['email']);
  if (www) rb.observe(capture, subject, 'registry.www', www, `${key}#firma.www`);
  if (email) rb.observe(capture, subject, 'registry.email', email, `${key}#firma.email`);
}
