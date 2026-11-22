/** Exports of a report (STIX 2.1, MISP, CSV) derived from the same data as the HTML document. */
import { toCsv, CSV_EXPORTS, type CsvExport } from './csv.ts';
import { toMispEvent } from './misp.ts';
import type { ExportInput } from './select.ts';
import { toStixBundle, TLP_LEVELS, type TlpLevel } from './stix.ts';

export { csvCell, CSV_EXPORTS, toCsv, type CsvExport } from './csv.ts';
export { likelihoodValue, toMispEvent } from './misp.ts';
export type { ExportInput } from './select.ts';
export { stixScoId, TLP_LEVELS, TLP_MARKINGS, toStixBundle, type StixOptions, type TlpLevel } from './stix.ts';
export { uuidv5 } from './ids.ts';

export const EXPORT_KINDS = ['stix', 'misp', ...CSV_EXPORTS] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_MEDIA_TYPES: Readonly<Record<ExportKind, string>> = {
  stix: 'application/stix+json;version=2.1',
  misp: 'application/json',
  csv_links: 'text/csv; charset=utf-8',
  csv_evidence: 'text/csv; charset=utf-8',
  csv_cash_out: 'text/csv; charset=utf-8',
  csv_changes: 'text/csv; charset=utf-8',
};

export const EXPORT_FILE_EXTENSIONS: Readonly<Record<ExportKind, string>> = {
  stix: 'stix.json',
  misp: 'misp.json',
  csv_links: 'links.csv',
  csv_evidence: 'evidence.csv',
  csv_cash_out: 'cash_out.csv',
  csv_changes: 'changes.csv',
};

export const isExportKind = (value: string): value is ExportKind => (EXPORT_KINDS as readonly string[]).includes(value);

export interface ExportSettings {
  producerName: string;
  tlp: TlpLevel;
}

export interface ExportArtifact {
  kind: ExportKind;
  mediaType: string;
  content: string;
}

/** TLP level from configuration text; anything unknown falls back to the safest default of the project, AMBER. */
export const parseTlp = (value: string | undefined): TlpLevel =>
  TLP_LEVELS.find((l) => l === value?.trim().toLowerCase()) ?? 'amber';

/** All six exports of a report, in a fixed order. */
export function buildExports(input: ExportInput, settings: ExportSettings): ExportArtifact[] {
  const make = (kind: ExportKind): string => {
    if (kind === 'stix') return toStixBundle(input, { producerName: settings.producerName, tlp: settings.tlp }).json;
    if (kind === 'misp') return toMispEvent(input, { tlp: settings.tlp }).json;
    return toCsv(kind satisfies CsvExport, input);
  };
  return EXPORT_KINDS.map((kind) => ({ kind, mediaType: EXPORT_MEDIA_TYPES[kind], content: make(kind) }));
}
