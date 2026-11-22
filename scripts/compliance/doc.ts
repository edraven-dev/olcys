/**
 * Generated part of docs/compliance/licenses.md: direct npm dependencies per workspace, Python packages, container
 * images, a summary of transitive licences, gate status and links to the SBOMs. Only the block between the
 * `generated:licenses` markers is replaced; the hand-maintained sections around it stay untouched.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { cmp } from './cyclonedx.ts';
import type { ImageFinding, ImageSpec } from './images.ts';
import type { NpmComponent } from './npm.ts';
import type { PythonComponent } from './python.ts';
import { decideComponent, type LicenceException, type LicencePolicy } from './policy.ts';

export const START_MARKER = '<!-- generated:licenses:start -->';
export const END_MARKER = '<!-- generated:licenses:end -->';

export interface LicensesDocInput {
  npm: NpmComponent[];
  python: PythonComponent[];
  pythonPurposes: Record<string, string>;
  npmPurposes: Record<string, string>;
  images: ImageFinding[];
  policy: LicencePolicy;
  exceptions: LicenceException[];
  /** Paths of the SBOM files relative to the document. */
  sbomLinks: { npm: string; python: string };
  /** True when uv.lock is committed (Python transitive packages are covered). */
  pythonHasLock: boolean;
}

const cell = (s: string): string => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const row = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
const table = (head: string[], rows: string[][]): string =>
  [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

export function missingPurposes(input: Pick<LicensesDocInput, 'npm' | 'npmPurposes'>): string[] {
  return input.npm.filter((c) => c.direct && !input.npmPurposes[c.name]).map((c) => c.name);
}

const where = (c: NpmComponent): string =>
  c.usedBy.map((u) => `${u.workspace === '.' ? 'root' : u.workspace}${u.dev ? ' (dev)' : ''}`).join(', ');

export function renderLicensesDoc(input: LicensesDocInput): string {
  const missing = missingPurposes(input);
  if (missing.length > 0) {
    throw new Error(
      `config/compliance/components.yaml: add a Polish purpose for: ${[...new Set(missing)].toSorted(cmp).join(', ')}`,
    );
  }
  const direct = input.npm.filter((c) => c.direct);
  const transitive = input.npm.filter((c) => !c.direct);

  const verdicts = [
    ...input.npm.map((c) => decideComponent(c, input.policy, input.exceptions).verdict),
    ...input.python.map((c) => decideComponent(c, input.policy, input.exceptions).verdict),
    ...input.images.map((i) => i.decision.verdict),
  ];
  const bad = verdicts.filter((v) => v !== 'allow').length;

  const npmTable = table(
    ['Komponent', 'Wersja', 'Licencja (SPDX)', 'Zastosowanie', 'Gdzie'],
    direct.map((c) => [c.name, c.version, c.licence ?? '—', input.npmPurposes[c.name] ?? '', where(c)]),
  );
  const pythonRows = input.python.map((c) => [
    c.name,
    c.version,
    c.licence ?? '—',
    c.direct ? (input.pythonPurposes[c.name] ?? '') : 'zależność przechodnia',
    `${c.workspace ?? ''}${c.direct ? '' : ' (uv.lock)'}`,
  ]);
  const imageRows = input.images.map((i) => {
    const spec: ImageSpec | undefined = i.spec;
    return [
      i.repository,
      i.tag,
      spec?.licence ?? '—',
      spec?.purpose ?? '',
      `${i.file} (${i.where})`,
      spec?.separateService ? 'tak' : 'nie',
    ];
  });

  const counts = new Map<string, { runtime: number; dev: number }>();
  for (const c of transitive) {
    const key = c.licence ?? '—';
    const entry = counts.get(key) ?? { runtime: 0, dev: 0 };
    entry[c.scope] += 1;
    counts.set(key, entry);
  }
  const summaryRows = [...counts]
    .toSorted((a, b) => b[1].runtime + b[1].dev - (a[1].runtime + a[1].dev) || cmp(a[0], b[0]))
    .map(([licence, n]) => [licence, String(n.runtime), String(n.dev), String(n.runtime + n.dev)]);

  return [
    'Poniższe tabele są generowane z `pnpm-lock.yaml`, `services/osint-py/pyproject.toml`, `compose.yml`, Dockerfile i `config/compliance/components.yaml` poleceniem `pnpm licenses:docs` (sprawdzanym w `pnpm check`) — nie edytuj ich ręcznie.',
    '',
    '### Status bramki licencyjnej',
    '',
    `- Sprawdzone komponenty: ${verdicts.length} (npm: ${input.npm.length}, Python: ${input.python.length}, obrazy: ${input.images.length}).`,
    bad === 0
      ? '- Wynik: wszystkie komponenty zgodne z polityką licencyjną (`config/licenses.json`).'
      : `- Wynik: **${bad} komponentów wymaga decyzji** (uruchom \`pnpm compliance:licences\` i \`pnpm compliance:images\`).`,
    `- Wyjątki licencyjne (\`config/compliance/license-exceptions.yaml\`): ${input.exceptions.length}.`,
    `- SBOM (CycloneDX 1.6): [npm](${input.sbomLinks.npm}), [Python](${input.sbomLinks.python}).`,
    '',
    '### Zależności bezpośrednie npm',
    '',
    `Wszystkie zależności bezpośrednie wszystkich pakietów monorepo (${direct.length} pakietów); „(dev)” oznacza zależność deweloperską.`,
    '',
    npmTable,
    '',
    '### Pakiety Pythona (services/osint-py)',
    '',
    input.pythonHasLock
      ? 'Zależności bezpośrednie i przechodnie z `uv.lock`; licencje pochodzą z zatwierdzonej tabeli w `config/compliance/components.yaml`.'
      : 'Zależności bezpośrednie z `pyproject.toml` (przypięte `==`). Plik `uv.lock` nie jest jeszcze zatwierdzony, więc zależności przechodnie nie są ujęte w SBOM; licencje pochodzą z zatwierdzonej tabeli w `config/compliance/components.yaml`.',
    '',
    table(['Komponent', 'Wersja', 'Licencja (SPDX)', 'Zastosowanie', 'Gdzie'], pythonRows),
    '',
    '### Obrazy kontenerów',
    '',
    'Każdy `image:` z `compose.yml` i każde `FROM` z Dockerfile musi mieć wpis w `config/compliance/components.yaml`; licencje GPL/AGPL/LGPL są dopuszczone wyłącznie dla osobnych, niemodyfikowanych usług (`separateService: true`).',
    '',
    table(['Obraz', 'Tag', 'Licencja (SPDX)', 'Zastosowanie', 'Gdzie', 'Osobna usługa'], imageRows),
    '',
    '### Zależności przechodnie npm (podsumowanie)',
    '',
    `${transitive.length} pakietów przechodnich; pełna lista z wersjami, skrótami i licencjami jest w SBOM npm.`,
    '',
    table(['Licencja (SPDX)', 'Runtime', 'Tylko dev', 'Razem'], summaryRows),
  ].join('\n');
}

export function replaceGenerated(document: string, generated: string): string {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`document must contain ${START_MARKER} and ${END_MARKER} (in this order)`);
  }
  return `${document.slice(0, start + START_MARKER.length)}\n\n${generated}\n\n${document.slice(end)}`;
}

export async function writeLicensesDoc(path: string, generated: string): Promise<boolean> {
  const current = await readFile(path, 'utf8');
  const next = replaceGenerated(current, generated);
  if (next === current) return false;
  await writeFile(path, next);
  return true;
}

export async function checkLicensesDoc(path: string, generated: string): Promise<boolean> {
  const current = await readFile(path, 'utf8');
  return replaceGenerated(current, generated) === current;
}
