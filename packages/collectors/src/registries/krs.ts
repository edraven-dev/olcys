/**
 * KRS Open API (National Court Register, CC0): current extract of a company by its KRS number only. The registry of
 * businesses (`rejestr=P`) is tried first and the registry of associations and foundations (`S`) when it answers 404.
 * Board members, proxies and partners are recorded as name and role; their personal identifiers (PESEL) are never
 * read and never become pivots. The API sometimes answers a "Przerwa techniczna" HTML page with status 200: that is an
 * error ("KRS API maintenance"), not an empty register.
 */
import type { Capture, CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { asArray, asObject, asText, joinText, registryFetch, type Json, type RegistryAnswer } from './common.ts';
import { normalizeKrs, normalizeNip } from './polish-ids.ts';

export const KRS_SOURCE_ID = 'krs';
export const KRS_BASE_URL = 'https://api-krs.ms.gov.pl/api/krs';
export const KRS_PARSER_VERSION = 'krs-open-api.v1';
const SOFTWARE = [{ name: 'parser:krs', version: KRS_PARSER_VERSION }];
const REGISTERS = ['P', 'S'] as const;

export interface KrsOptions {
  baseUrl?: string;
}

function krsNumbers(input: CollectorInput): string[] {
  const out = new Set<string>();
  for (const value of input.values ?? []) {
    const krs = value.kind === 'krs' ? normalizeKrs(value.value) : undefined;
    if (krs) out.add(krs);
  }
  return [...out];
}

export function krsExtractUrl(baseUrl: string, krs: string, register: 'P' | 'S'): string {
  return `${baseUrl.replace(/\/+$/, '')}/OdpisAktualny/${krs}?rejestr=${register}&format=json`;
}

/** Surname and first name of a KRS person entry, or the `nazwa` of a legal-person partner; never an identifier. */
export function krsEntryName(entry: Json): string | undefined {
  const company = asText(entry['nazwa']);
  if (company) return company;
  const surname = asObject(entry['nazwisko']);
  const given = asObject(entry['imiona']);
  return joinText([
    asText(given?.['imie']),
    asText(given?.['imieDrugie']),
    asText(surname?.['nazwiskoICzlon']),
    asText(surname?.['nazwiskoIICzlon']),
  ]);
}

function formatAddress(dzial1: Json | undefined): string | undefined {
  const address = asObject(asObject(dzial1?.['siedzibaIAdres'])?.['adres']);
  if (!address) return undefined;
  const house = joinText(
    [asText(address['nrDomu']), asText(address['nrLokalu']) ? `/${asText(address['nrLokalu'])}` : undefined],
    '',
  );
  const street = joinText([asText(address['ulica']), house]);
  return joinText([street, joinText([asText(address['kodPocztowy']), asText(address['miejscowosc'])])], ', ');
}

export function createKrsCollector(options: KrsOptions = {}): CollectorFactory {
  const baseUrl = options.baseUrl ?? KRS_BASE_URL;
  return {
    sourceId: KRS_SOURCE_ID,
    platform: KRS_SOURCE_ID,
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => krsNumbers(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const numbers = krsNumbers(input);
          if (!numbers.length) {
            rb.note('unsupported_input', 'no valid KRS number');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const krs of numbers) {
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            await extract(http, rb, baseUrl, krs);
          }
          return rb.build();
        },
      };
    },
  };
}

async function extract(http: SourceHttp, rb: ResultBuilder, baseUrl: string, krs: string): Promise<void> {
  let answer: RegistryAnswer | undefined;
  for (const register of REGISTERS) {
    // The second register is tried only after a 404 from the first.
    // oxlint-disable-next-line no-await-in-loop
    answer = await registryFetch(http, {
      url: krsExtractUrl(baseUrl, krs, register),
      purpose: `krs extract (register ${register})`,
      software: SOFTWARE,
      notJsonNote: { code: 'fetch_error', detail: 'KRS API maintenance' },
    });
    rb.addPage({ status: answer.status, ...(answer.capture ? { capture: answer.capture } : {}), notes: answer.notes });
    if (answer.status !== 'not_found' || http.stopped()) break;
  }
  if (!answer) return;
  if (answer.status === 'not_found') rb.affirmNotFound(`KRS ${krs} is in neither register`);
  if (answer.status !== 'ok' || !answer.capture) return;
  observeExtract(rb, answer.capture, krs, answer.json);
}

function observeExtract(rb: ResultBuilder, capture: Capture, requested: string, json: unknown): void {
  const odpis = asObject(asObject(json)?.['odpis']);
  const dane = asObject(odpis?.['dane']);
  const dzial1 = asObject(dane?.['dzial1']);
  const dzial2 = asObject(dane?.['dzial2']);
  const entity = asObject(dzial1?.['danePodmiotu']);
  const ids = asObject(entity?.['identyfikatory']);
  const number = asText(asObject(odpis?.['naglowekA'])?.['numerKRS']);
  const krs = (number ? normalizeKrs(number) : undefined) ?? requested;
  const key = `krs:${krs}`;
  const subject = { type: 'page' as const, key };
  const fact = (property: string, value: string | undefined, path: string): void => {
    if (value) rb.observe(capture, subject, property, value, `${key}#${path}`);
  };
  fact('registry.krs', krs, 'odpis.naglowekA.numerKRS');
  fact('registry.business_name', asText(entity?.['nazwa']), 'odpis.dane.dzial1.danePodmiotu.nazwa');
  const nip = asText(ids?.['nip']);
  fact('registry.nip', nip ? normalizeNip(nip) : undefined, 'odpis.dane.dzial1.danePodmiotu.identyfikatory.nip');
  fact('registry.regon', asText(ids?.['regon']), 'odpis.dane.dzial1.danePodmiotu.identyfikatory.regon');
  fact('registry.business_location', formatAddress(dzial1), 'odpis.dane.dzial1.siedzibaIAdres');
  // Third parties: name and role only; identifiers inside the entries are never read.
  const representation = asObject(dzial2?.['reprezentacja']);
  asArray(representation?.['sklad']).forEach((entry, i) => {
    const member = asObject(entry) ?? {};
    const name = krsEntryName(member);
    const role = asText(member['funkcjaWOrganie']) ?? 'członek organu';
    if (name) fact('registry.representative', `${name} — ${role}`, `odpis.dane.dzial2.reprezentacja.sklad[${i}]`);
  });
  asArray(dzial2?.['prokurenci']).forEach((entry, i) => {
    const name = krsEntryName(asObject(entry) ?? {});
    if (name) fact('registry.representative', `${name} — prokurent`, `odpis.dane.dzial2.prokurenci[${i}]`);
  });
  asArray(dzial1?.['wspolnicySpzoo']).forEach((entry, i) => {
    const name = krsEntryName(asObject(entry) ?? {});
    if (name) fact('registry.partner', `${name} — wspólnik`, `odpis.dane.dzial1.wspolnicySpzoo[${i}]`);
  });
}
