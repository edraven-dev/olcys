/**
 * Entity registries without addresses: the ESMA interim MiCA register (`CASPS.csv`) and the Polish register of
 * virtual-currency activity (positioned PDF text to entities). Only legal entities are kept; natural persons from the
 * Polish register are never stored (data minimisation).
 */
import type { IsoDate } from '@olcys/core';
import { parseCsv, parseDate } from './common.ts';

export interface EntityRecord {
  registry: 'esma_casps' | 'pl_vasp';
  /** LEI (ESMA) or `RDWW-<n>` (Polish register). */
  key: string;
  name: string;
  /** Crypto-for-funds exchange (ESMA service c, or exchange for payment means in the Polish register). */
  fiatCapable: boolean;
  services: string[];
  mayServePL?: boolean;
  validFrom?: IsoDate;
  validTo?: IsoDate;
  homeState?: string;
  commercialName?: string;
  /**
   * ESMA: validity per service (permission). One LEI can hold several authorisations that end on different days, so
   * `fiatCapable` at a date comes from the services valid on that day (`serviceValidAt`), not from the merged range.
   */
  servicePeriods?: ServicePeriod[];
}

export interface ServicePeriod {
  code: string;
  validFrom?: IsoDate;
  validTo?: IsoDate;
}

export interface EntityParseResult {
  records: EntityRecord[];
  warnings: string[];
}

const periodValidAt = (p: ServicePeriod, date: IsoDate): boolean =>
  (p.validFrom === undefined || p.validFrom <= date) && (p.validTo === undefined || date <= p.validTo);

/** True when the service `code` is permitted on `date` (without per-service periods: the record's own validity). */
export function serviceValidAt(record: EntityRecord, code: string, date: IsoDate): boolean {
  if (!record.servicePeriods) return record.services.includes(code) && recordValidAt(record, date);
  return record.servicePeriods.some((p) => p.code === code && periodValidAt(p, date));
}

/** True when the record is in force on `date` (`validFrom ≤ date ≤ validTo`, inclusive). */
export function recordValidAt(record: EntityRecord, date: IsoDate): boolean {
  if (record.servicePeriods?.length) return record.servicePeriods.some((p) => periodValidAt(p, date));
  return (
    (record.validFrom === undefined || record.validFrom <= date) &&
    (record.validTo === undefined || date <= record.validTo)
  );
}

/** Repairs UTF-8 text that was read as latin-1 (`Ã³` for `ó`), then normalises to NFC. */
export function repairText(value: string): string {
  let text = value;
  if (/[ÃÂÅ][\u0080-¿]/.test(text)) {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    if (!repaired.includes('�')) text = repaired;
  }
  return text.normalize('NFC').trim();
}

const cell = (row: string[], i: number): string => repairText(row[i] ?? '');

function periodsOf(services: string[], from: IsoDate | undefined, to: IsoDate | undefined): ServicePeriod[] {
  const periods: ServicePeriod[] = [];
  for (const code of new Set(services)) {
    const period: ServicePeriod = { code };
    if (from) period.validFrom = from;
    if (to) period.validTo = to;
    periods.push(period);
  }
  return periods;
}

export function parseEsmaCasps(csv: string): EntityParseResult {
  const firstLine = csv.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const [header, ...body] = parseCsv(csv, delimiter);
  if (!header) throw new Error('ESMA CASPS: empty file');
  const col = (name: string): number => header.findIndex((h) => repairText(h).toLowerCase() === name.toLowerCase());
  const idx = {
    name: col('ae_lei_name'),
    lei: col('ae_lei'),
    commercial: col('ae_commercialName') >= 0 ? col('ae_commercialName') : col('ae_commercial_name'),
    state: col('ae_homeMemberState'),
    start: col('ac_authorisationNotificationDate'),
    end: col('ac_authorisationEndDate'),
    service: col('ac_serviceCode'),
    cou: col('ac_serviceCode_cou'),
  };
  if (idx.lei < 0 || idx.name < 0 || idx.service < 0)
    throw new Error('ESMA CASPS: ae_lei, ae_lei_name and ac_serviceCode are required');
  const warnings: string[] = [];
  const byLei = new Map<string, EntityRecord>();
  const open = new Set<string>();
  for (const [n, row] of body.entries()) {
    const lei = cell(row, idx.lei).replace(/\.+$/, '').toUpperCase();
    if (!/^[A-Z0-9]{20}$/.test(lei)) {
      warnings.push(`ESMA CASPS: row ${n + 2} has an invalid LEI "${lei}", skipped`);
      continue;
    }
    const services = [...cell(row, idx.service).matchAll(/(?:^|[\s;,])([a-j])\./gi)].map((m) =>
      (m[1] as string).toLowerCase(),
    );
    const cou = cell(row, idx.cou)
      .toUpperCase()
      .split(/[^A-Z]+/);
    const from = parseDate(cell(row, idx.start));
    const to = parseDate(cell(row, idx.end));
    const existing = byLei.get(lei);
    if (!existing) {
      const commercial = idx.commercial >= 0 ? cell(row, idx.commercial) : '';
      byLei.set(lei, {
        registry: 'esma_casps',
        key: lei,
        name: cell(row, idx.name),
        fiatCapable: services.includes('c'),
        services: [...new Set(services)].toSorted(),
        mayServePL: cou.includes('PL'),
        ...(from ? { validFrom: from } : {}),
        ...(to ? { validTo: to } : {}),
        ...(idx.state >= 0 && cell(row, idx.state) ? { homeState: cell(row, idx.state).toUpperCase() } : {}),
        ...(commercial ? { commercialName: commercial } : {}),
        servicePeriods: periodsOf(services, from, to),
      });
      if (!to) open.add(lei);
      continue;
    }
    // One entity, several authorisation rows: union of services, widest validity.
    existing.services = [...new Set([...existing.services, ...services])].toSorted();
    existing.fiatCapable ||= services.includes('c');
    existing.servicePeriods = [...(existing.servicePeriods ?? []), ...periodsOf(services, from, to)];
    existing.mayServePL ||= cou.includes('PL');
    if (from && (!existing.validFrom || from < existing.validFrom)) existing.validFrom = from;
    if (!to) {
      open.add(lei);
      delete existing.validTo;
    } else if (!open.has(lei) && (!existing.validTo || to > existing.validTo)) existing.validTo = to;
  }
  return { records: [...byLei.values()], warnings };
}

export interface PositionedText {
  str: string;
  x: number;
  /** Distance from the top of the page (grows downwards). */
  y: number;
  page: number;
}

const PL_COLUMNS = [
  { key: 'number', header: 'numer w rejestrze' },
  { key: 'entered', header: 'data wpisu' },
  { key: 'name', header: 'imię i nazwisko' },
  { key: 'krs', header: 'numer krs' },
  { key: 'nip', header: 'nip' },
  { key: 'services', header: 'rodzaj świadczonych usług' },
  { key: 'suspension', header: 'zawieszenie' },
  { key: 'end', header: 'zakończenie' },
] as const;
type PlColumn = (typeof PL_COLUMNS)[number]['key'];

/**
 * Legal-form tokens, matched as whole words or abbreviations (never inside a surname: „Przykładowska” is not „SKA”).
 * A name without such a token and without a KRS number belongs to a natural person and is never stored.
 */
const WORD = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
const LEGAL_FORM_WORDS = new RegExp(
  `${WORD}(?:sp\\.\\s*z\\s*o\\.\\s*o\\.?|sp\\.\\s*(?:k|j|p)\\.?|spółka\\s+(?:z\\s+ograniczoną\\s+odpowiedzialnością|akcyjna|komandytowo-akcyjna|komandytowa|jawna|partnerska)|prosta\\s+spółka\\s+akcyjna|ltd|gmbh|uab|s\\.r\\.o\\.|inc\\.?)${END}`,
  'iu',
);
// Case-sensitive: „SA” / „S.A.” / „S.K.A.” / „P.S.A.” in capitals only.
const LEGAL_FORM_CAPS = new RegExp(`${WORD}(?:S\\.A\\.|SA|S\\.K\\.A\\.|SKA|P\\.S\\.A\\.|PSA)${END}`, 'u');
const hasLegalForm = (name: string): boolean => LEGAL_FORM_WORDS.test(name) || LEGAL_FORM_CAPS.test(name);

export function validNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((s, w, i) => s + w * Number(nip[i]), 0);
  const check = sum % 11;
  return check !== 10 && check === Number(nip[9]);
}

/**
 * Polish register rows from positioned text. Columns come from the header's x positions, wrapped cells are joined,
 * rows start at an `RDWW-<n>` number. Natural persons (no KRS number and no legal-form suffix) are dropped.
 */
export function parsePlRegister(items: readonly PositionedText[]): EntityParseResult {
  const warnings: string[] = [];
  const clean = items.map((i) => ({ ...i, str: i.str.normalize('NFC').trim() })).filter((i) => i.str !== '');
  const headers = PL_COLUMNS.map((c) => {
    const found = clean.find((i) => i.str.toLowerCase().startsWith(c.header));
    return found ? { key: c.key, x: found.x } : undefined;
  });
  if (headers.some((h) => h === undefined)) throw new Error('PL register: column headers not found');
  const cols = (headers as { key: PlColumn; x: number }[]).toSorted((a, b) => a.x - b.x);
  const columnOf = (x: number): PlColumn => {
    let key = (cols[0] as { key: PlColumn }).key;
    for (const c of cols) if (x >= c.x - 2) key = c.key;
    return key;
  };
  const headerTexts = new Set(PL_COLUMNS.map((c) => c.header));
  const ordered = clean
    .filter((i) => ![...headerTexts].some((h) => i.str.toLowerCase().startsWith(h)))
    .toSorted((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const rows: Partial<Record<PlColumn, string[]>>[] = [];
  for (const item of ordered) {
    const column = columnOf(item.x);
    if (column === 'number' && /^RDWW-\d+$/i.test(item.str)) rows.push({});
    const row = rows[rows.length - 1];
    if (!row) continue;
    (row[column] ??= []).push(item.str);
  }
  const records: EntityRecord[] = [];
  let previous: number | undefined;
  for (const row of rows) {
    const text = (k: PlColumn): string => (row[k] ?? []).join(' ').replace(/\s+/g, ' ').trim();
    const key = text('number').toUpperCase();
    const n = Number(key.slice(5));
    if (previous !== undefined && n !== previous + 1)
      warnings.push(`PL register: numbering jumps from RDWW-${previous} to ${key}`);
    previous = n;
    const name = text('name');
    const krs = text('krs').replace(/\D/g, '');
    if (krs.length !== 10 && !hasLegalForm(name)) continue; // natural person: not stored
    const nip = text('nip').replace(/\D/g, '');
    if (nip && !validNip(nip)) warnings.push(`PL register: ${key} has an invalid NIP checksum`);
    const servicesText = text('services').toLowerCase();
    const services: string[] = [];
    const fiatCapable = /wymiana\s+pomiędzy\s+walutami\s+wirtualnymi\s+a\s+środkami\s+płatniczymi/.test(servicesText);
    if (fiatCapable) services.push('virtual_fiat_exchange');
    if (/wymiana\s+pomiędzy\s+walutami\s+wirtualnymi(?!\s+a\s)/.test(servicesText))
      services.push('virtual_virtual_exchange');
    if (/portfel|rachunk/.test(servicesText)) services.push('custody');
    if (/pośredni/.test(servicesText)) services.push('intermediation');
    const from = parseDate(text('entered'));
    const ends = [parseDate(text('suspension')), parseDate(text('end'))]
      .filter((d): d is string => d !== undefined)
      .toSorted();
    const to = ends[0];
    records.push({
      registry: 'pl_vasp',
      key,
      name,
      fiatCapable,
      services,
      mayServePL: true,
      homeState: 'PL',
      ...(from ? { validFrom: from } : {}),
      ...(to ? { validTo: to } : {}),
    });
  }
  return { records, warnings };
}
