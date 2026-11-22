/**
 * Generated part of `docs/compliance/sources.md`: tables of the source register per status and the list of forbidden
 * tools. Only the block between the markers is generated; the prose around it is written by hand.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { SourceDescriptor } from '@olcys/core';
import { REPO_ROOT } from '../framework/config.ts';
import { DEFAULT_FORBIDDEN_TOOLS_PATH, loadForbiddenTools, type ForbiddenTools } from './forbidden-tools.ts';
import { DEFAULT_SOURCES_PATH } from '../framework/source-registry.ts';
import { loadSourceRegister, type SourceRegister } from './register.ts';
import { join } from 'node:path';

export const DOC_START = '<!-- generated:sources:start -->';
export const DOC_END = '<!-- generated:sources:end -->';
export const DEFAULT_DOC_PATH = join(REPO_ROOT, 'docs', 'compliance', 'sources.md');

export type DocLang = 'pl' | 'en';

const TEXT = {
  pl: {
    generated:
      'Poniższe tabele są generowane z `config/sources.yaml` i `config/forbidden-tools.yaml` poleceniem `pnpm compliance:sources` — nie edytuj ich ręcznie.',
    status: {
      GREEN: ['Źródła GREEN', 'Używane domyślnie (lub po włączeniu w sprawie), bez dodatkowego uzasadnienia.'],
      AMBER: [
        'Źródła AMBER',
        'Wyłączone domyślnie; analityk włącza je w sprawie z uzasadnieniem (co najmniej 20 znaków), które trafia do dziennika i raportu.',
      ],
      RED: [
        'Źródła RED',
        'Nigdy nie są kontaktowane; wymuszone w kodzie (schemat rejestru, walidacja zakresu, lista dozwolonych hostów, kolektory).',
      ],
    },
    columns: [
      'Źródło',
      'Rodzaj',
      'Domyślnie włączone',
      'Limit zapytań',
      'Ujawnia identyfikator',
      'Wiarygodność (Admiralty)',
      'Regulamin',
      'Uzasadnienie',
    ],
    registerLabel: 'Rejestr',
    yes: 'tak',
    no: 'nie',
    noTerms: 'brak opublikowanego regulaminu',
    noRate: 'brak (zablokowane)',
    local: 'bez sieci',
    perSecond: 's',
    blocked: 'Blokowane hosty',
    tools: 'Narzędzia niedozwolone',
    toolsIntro:
      'Narzędzia i pakiety, których projekt nie używa, wraz z powodem. Skan zależności w testach zgłasza każdą próbę ich dodania.',
    toolColumns: ['Narzędzie', 'Kategoria', 'Powód', 'Pakiety'],
    categories: {
      breach_data: 'Dane z wycieków',
      account_probing: 'Sondowanie kont',
      session_login: 'Sesje i logowanie',
      scraping_evasion: 'Scraping i omijanie zabezpieczeń',
      licence: 'Niedozwolona licencja',
      telemetry: 'Telemetria lub przepływ danych',
      unmaintained: 'Nieutrzymywane lub niebezpieczne',
    },
    rules: 'Ograniczenia funkcji dozwolonych narzędzi',
  },
  en: {
    generated:
      'The tables below are generated from `config/sources.yaml` and `config/forbidden-tools.yaml` by `pnpm compliance:sources` — do not edit them by hand.',
    status: {
      GREEN: ['GREEN sources', 'Usable by default (or when a case enables them), no extra justification.'],
      AMBER: [
        'AMBER sources',
        'Off by default; an analyst enables them per case with a justification (at least 20 characters) that is logged and shown in the report.',
      ],
      RED: [
        'RED sources',
        'Never contacted; enforced in code (register schema, scope validation, host allow-list, collectors).',
      ],
    },
    columns: [
      'Source',
      'Kind',
      'Enabled by default',
      'Rate limit',
      'Discloses identifier',
      'Reliability (Admiralty)',
      'Terms',
      'Rationale',
    ],
    registerLabel: 'Register',
    yes: 'yes',
    no: 'no',
    noTerms: 'no published terms',
    noRate: 'none (blocked)',
    local: 'no network',
    perSecond: 's',
    blocked: 'Blocked hosts',
    tools: 'Forbidden tools',
    toolsIntro:
      'Tools and packages the project does not use, with the reason. The dependency scan in the tests reports any attempt to add them.',
    toolColumns: ['Tool', 'Category', 'Reason', 'Packages'],
    categories: {
      breach_data: 'Breach data',
      account_probing: 'Account probing',
      session_login: 'Sessions and logins',
      scraping_evasion: 'Scraping and evasion',
      licence: 'Licence not allowed',
      telemetry: 'Telemetry or data flow',
      unmaintained: 'Unmaintained or unsafe',
    },
    rules: 'Feature restrictions of allowed tools',
  },
} as const;

const cell = (text: string): string =>
  text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function rateOf(d: SourceDescriptor, t: (typeof TEXT)[DocLang]): string {
  if (d.compliance === 'RED') return t.noRate;
  if (d.allowedHosts.length === 0 && d.rateLimit.requests === 0) return t.local;
  const { requests, perSeconds } = d.rateLimit;
  return `${requests} / ${perSeconds} ${t.perSecond}`;
}

function sourceRow(d: SourceDescriptor, lang: DocLang): string[] {
  const t = TEXT[lang];
  const name = lang === 'pl' ? d.namePl : d.name;
  const note = lang === 'pl' ? d.complianceNotePl : d.complianceNote;
  const blocked =
    d.compliance === 'RED' && d.blockedHosts?.length ? ` ${t.blocked}: ${d.blockedHosts.join(', ')}.` : '';
  return [
    `${name} (\`${d.id}\`)`,
    d.kind,
    d.enabledByDefault ? t.yes : t.no,
    rateOf(d, t),
    d.sendsIdentifiersExternally ? t.yes : t.no,
    d.reliability,
    d.tosUrl ?? t.noTerms,
    `${note}${blocked}`,
  ];
}

/** The generated block (without the markers): source tables per status, then the forbidden tools. */
export function renderSourcesDoc(register: SourceRegister, tools: ForbiddenTools, lang: DocLang): string {
  const t = TEXT[lang];
  const parts: string[] = [t.generated, `${t.registerLabel}: \`${register.version}\`, SHA-256 \`${register.sha256}\`.`];
  for (const status of ['GREEN', 'AMBER', 'RED'] as const) {
    const rows = [...register.entries.values()]
      .filter((d) => d.compliance === status)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((d) => sourceRow(d, lang));
    const [title, intro] = t.status[status];
    parts.push(`### ${title}`, intro, table(t.columns, rows));
  }
  parts.push(
    `### ${t.tools}`,
    t.toolsIntro,
    table(
      t.toolColumns,
      tools.tools.map((tool) => [
        `[${tool.name}](${tool.url})`,
        t.categories[tool.category],
        tool.reason[lang],
        [
          ...tool.packages.npm.map((p) => `npm:${p}`),
          ...tool.packages.pypi.map((p) => `pypi:${p}`),
          ...tool.packages.images.map((p) => `image:${p}`),
        ].join(', ') || '—',
      ]),
    ),
  );
  if (tools.featureRules.length) {
    parts.push(`#### ${t.rules}`);
    for (const rule of tools.featureRules)
      parts.push(`**${rule.name}**\n\n${rule[lang].map((r) => `- ${r}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Replaces the generated block of `doc` (markers kept); throws when the markers are missing. */
export function replaceGeneratedBlock(doc: string, block: string): string {
  const start = doc.indexOf(DOC_START);
  const end = doc.indexOf(DOC_END);
  if (start === -1 || end === -1 || end < start) throw new Error(`the document needs ${DOC_START} and ${DOC_END}`);
  return `${doc.slice(0, start + DOC_START.length)}\n\n${block}\n\n${doc.slice(end)}`;
}

export interface DocOptions {
  lang?: DocLang;
  /** Document to update or check (default `docs/compliance/sources.md`). */
  out?: string;
  sourcesPath?: string;
  toolsPath?: string;
}

async function renderInto(options: DocOptions): Promise<{ path: string; current: string | undefined; next: string }> {
  const [register, tools] = await Promise.all([
    loadSourceRegister(options.sourcesPath ?? DEFAULT_SOURCES_PATH),
    loadForbiddenTools(options.toolsPath ?? DEFAULT_FORBIDDEN_TOOLS_PATH),
  ]);
  const path = options.out ?? DEFAULT_DOC_PATH;
  const block = renderSourcesDoc(register, tools, options.lang ?? 'pl');
  let current: string | undefined;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  // A new file (e.g. the English mirror) holds the generated block only; an existing one keeps its prose.
  const next = replaceGeneratedBlock(current ?? `${DOC_START}\n${DOC_END}\n`, block);
  return { path, current, next };
}

/** Regenerates the block of the document and writes it; returns true when the file changed. */
export async function writeSourcesDoc(options: DocOptions = {}): Promise<boolean> {
  const { path, current, next } = await renderInto(options);
  if (current === next) return false;
  await writeFile(path, next);
  return true;
}

/** True when the committed document's generated block is current. */
export async function checkSourcesDoc(options: DocOptions = {}): Promise<{ path: string; upToDate: boolean }> {
  const { path, current, next } = await renderInto(options);
  return { path, upToDate: current === next };
}
