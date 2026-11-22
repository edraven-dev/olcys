/**
 * VAT white list ("Wykaz podatników VAT", Ministry of Finance): keyless official API answering by NIP or REGON with
 * the taxpayer's VAT status, registered bank accounts (the fiat-side pivot), representatives, clerks and partners.
 * The old `wl-api.mf.gov.pl` host is never used. The response's `requestId` is the official proof of the check and is
 * kept as an observation. Third parties are recorded as name and role only; PESEL fields are never read.
 */
import type { Capture, CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { asArray, asObject, asText, joinText, registryFetch, type Json } from './common.ts';
import { isValidNip, isValidNrb, isValidRegon, normalizeNip, normalizeNrb, warsawDate } from './polish-ids.ts';

export const VAT_SOURCE_ID = 'vat_whitelist';
export const VAT_BASE_URL = 'https://wykazpodatnikowvat.mf.gov.pl/api';
/** The search endpoint allows 100 queries a day; a run stays far below that. */
export const VAT_DEFAULT_MAX_SEARCH_CALLS = 10;
export const VAT_PARSER_VERSION = 'vat-whitelist.v1';
const SOFTWARE = [{ name: 'parser:vat_whitelist', version: VAT_PARSER_VERSION }];

export interface VatWhitelistOptions {
  baseUrl?: string;
  /** Search requests per run (default 10); further values are skipped with a note. */
  maxSearchCallsPerRun?: number;
}

interface Lookup {
  kind: 'nip' | 'regon';
  value: string;
}

function lookupsOf(input: CollectorInput): Lookup[] {
  const out: Lookup[] = [];
  const seen = new Set<string>();
  for (const value of input.values ?? []) {
    let lookup: Lookup | undefined;
    if (value.kind === 'nip') {
      const nip = normalizeNip(value.value);
      if (isValidNip(nip)) lookup = { kind: 'nip', value: nip };
    } else if (value.kind === 'regon') {
      const regon = value.value.trim();
      if (isValidRegon(regon)) lookup = { kind: 'regon', value: regon };
    }
    if (!lookup || seen.has(`${lookup.kind}:${lookup.value}`)) continue;
    seen.add(`${lookup.kind}:${lookup.value}`);
    out.push(lookup);
  }
  return out;
}

export function vatSearchUrl(baseUrl: string, lookup: Lookup, date: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/search/${lookup.kind}/${lookup.value}?date=${date}`;
}

/** `companyName`, else `firstName lastName`. */
function personName(entry: Json): string | undefined {
  return asText(entry['companyName']) ?? joinText([asText(entry['firstName']), asText(entry['lastName'])]);
}

const LIMIT_MESSAGE = /limit/i;

function subjectOf(json: unknown): Json | undefined {
  return asObject(asObject(asObject(json)?.['result'])?.['subject']);
}

export function createVatWhitelistCollector(options: VatWhitelistOptions = {}): CollectorFactory {
  const baseUrl = options.baseUrl ?? VAT_BASE_URL;
  const maxCalls = options.maxSearchCallsPerRun ?? VAT_DEFAULT_MAX_SEARCH_CALLS;
  return {
    sourceId: VAT_SOURCE_ID,
    platform: VAT_SOURCE_ID,
    create(descriptor, deps): SourceCollector {
      // One collector per run (see `CollectorRegistry.forScope`): the counter is the run's daily-quota budget.
      let calls = 0;
      return {
        descriptor,
        supports: (input) => lookupsOf(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const lookups = lookupsOf(input);
          if (!lookups.length) {
            rb.note('unsupported_input', 'no valid NIP or REGON');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const lookup of lookups) {
            if (http.stopped()) break;
            if (calls >= maxCalls) {
              rb.note('truncated', `search limit of ${maxCalls} calls per run reached; ${lookup.kind} skipped`);
              continue;
            }
            calls += 1;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            const answer = await registryFetch(http, {
              url: vatSearchUrl(baseUrl, lookup, warsawDate(ctx.clock)),
              purpose: `vat whitelist ${lookup.kind} lookup`,
              software: SOFTWARE,
              classify: (json, httpStatus) => {
                const message = asText(asObject(json)?.['message']);
                if (httpStatus >= 400 && message && LIMIT_MESSAGE.test(message)) {
                  return { status: 'blocked', reason: message, code: 'rate_limited' };
                }
                if (httpStatus >= 200 && httpStatus < 300 && !subjectOf(json)) {
                  return { status: 'not_found', reason: `no ${lookup.kind} entry on the VAT white list` };
                }
                return undefined;
              },
            });
            rb.addPage({
              status: answer.status,
              ...(answer.capture ? { capture: answer.capture } : {}),
              notes: answer.notes,
            });
            if (answer.status === 'not_found') rb.affirmNotFound(`${lookup.kind} ${lookup.value}`);
            const subject = subjectOf(answer.json);
            if (answer.status === 'ok' && answer.capture && subject) {
              observeSubject(
                rb,
                answer.capture,
                lookup,
                subject,
                asText(asObject(asObject(answer.json)?.['result'])?.['requestId']),
              );
            }
          }
          return rb.build();
        },
      };
    },
  };
}

function observeSubject(
  rb: ResultBuilder,
  capture: Capture,
  lookup: Lookup,
  subject: Json,
  requestId: string | undefined,
): void {
  const nip = asText(subject['nip']);
  const key = `vat:${nip ? normalizeNip(nip) : lookup.value}`;
  const entity = { type: 'page' as const, key };
  const fact = (property: string, value: string | undefined, path: string): void => {
    if (value) rb.observe(capture, entity, property, value, `${key}#${path}`);
  };
  fact('registry.business_name', asText(subject['name']), 'result.subject.name');
  fact('registry.nip', nip ? normalizeNip(nip) : undefined, 'result.subject.nip');
  fact('registry.regon', asText(subject['regon']), 'result.subject.regon');
  const krs = asText(subject['krs']);
  fact('registry.krs', krs, 'result.subject.krs');
  fact('registry.vat_status', asText(subject['statusVat']), 'result.subject.statusVat');
  // A sole proprietor's "residence address" is a home address: it is read only for an entity with a KRS number.
  const working = asText(subject['workingAddress']);
  if (working) fact('registry.business_location', working, 'result.subject.workingAddress');
  else if (krs)
    fact('registry.business_location', asText(subject['residenceAddress']), 'result.subject.residenceAddress');
  fact('registry.start_date', asText(subject['registrationLegalDate']), 'result.subject.registrationLegalDate');
  fact('registry.removal_date', asText(subject['removalDate']), 'result.subject.removalDate');
  asArray(subject['accountNumbers']).forEach((account, i) => {
    const nrb = typeof account === 'string' ? normalizeNrb(account) : '';
    if (isValidNrb(nrb))
      rb.observe(capture, entity, 'registry.bank_account', nrb, `${key}#result.subject.accountNumbers[${i}]`);
    else rb.note('unrecognised_markup', `accountNumbers[${i}] is not a valid NRB; skipped`);
  });
  if (typeof subject['hasVirtualAccounts'] === 'boolean') {
    fact('registry.has_virtual_accounts', String(subject['hasVirtualAccounts']), 'result.subject.hasVirtualAccounts');
  }
  // Third parties: name and role only (never an identifier, never a pivot).
  const people: [string, string, string][] = [
    ['representatives', 'registry.representative', 'reprezentant'],
    ['authorizedClerks', 'registry.representative', 'prokurent'],
    ['partners', 'registry.partner', 'wspólnik'],
  ];
  for (const [field, property, role] of people) {
    asArray(subject[field]).forEach((entry, i) => {
      const name = personName(asObject(entry) ?? {});
      if (name) rb.observe(capture, entity, property, `${name} — ${role}`, `${key}#result.subject.${field}[${i}]`);
    });
  }
  fact('registry.vat_request_id', requestId, 'result.requestId');
}
