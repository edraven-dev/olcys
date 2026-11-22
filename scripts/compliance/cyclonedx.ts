/** Minimal CycloneDX 1.6 JSON model and helpers shared by the npm and Python SBOM generators. */

export interface CycloneDxComponent {
  type: 'library' | 'application';
  'bom-ref': string;
  group?: string;
  name: string;
  version: string;
  scope?: 'required' | 'optional' | 'excluded';
  purl?: string;
  hashes?: Array<{ alg: string; content: string }>;
  licenses?: Array<{ license: { id: string } | { name: string } } | { expression: string }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDxBom {
  bomFormat: 'CycloneDX';
  specVersion: '1.6';
  version: 1;
  metadata: { component: CycloneDxComponent; properties: Array<{ name: string; value: string }> };
  components: CycloneDxComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

const encodeSegment = (s: string): string => encodeURIComponent(s);

/** purl for npm: `pkg:npm/%40scope/name@version` (the scope's `@` is percent-encoded per the purl spec). */
export function npmPurl(name: string, version: string): string {
  const [scope, rest] = name.startsWith('@') ? (name.split('/', 2) as [string, string]) : [undefined, name];
  const path = scope ? `${encodeSegment(scope)}/${encodeSegment(rest)}` : encodeSegment(rest);
  return `pkg:npm/${path}@${encodeSegment(version)}`;
}

export function pypiPurl(name: string, version: string): string {
  return `pkg:pypi/${encodeSegment(name.toLowerCase().replace(/[-_.]+/g, '-'))}@${encodeSegment(version)}`;
}

/** `sha512-<base64>` (npm integrity) → CycloneDX hash; other algorithms are skipped. */
export function integrityHash(integrity: string | undefined): { alg: string; content: string } | undefined {
  const m = /^(sha512|sha256|sha1)-(.+)$/.exec(integrity ?? '');
  if (!m) return undefined;
  const alg = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1] as 'sha512' | 'sha256' | 'sha1'];
  return { alg, content: Buffer.from(m[2] ?? '', 'base64').toString('hex') };
}

export function licenceEntry(licence: string | null, isExpression: boolean): CycloneDxComponent['licenses'] {
  if (!licence) return undefined;
  if (/^[A-Za-z0-9.+-]+$/.test(licence)) return [{ license: { id: licence } }];
  return isExpression ? [{ expression: licence }] : [{ license: { name: licence } }];
}

export const serialise = (bom: CycloneDxBom): string => `${JSON.stringify(bom, null, 2)}\n`;

/** Locale-independent string order (SBOMs must be byte-identical on every machine). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
