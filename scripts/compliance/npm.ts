/**
 * npm side of the SBOM: components come from pnpm-lock.yaml (every package in the lockfile, one component each),
 * licences from the installed package.json files (the same data license-checker reads) with a small committed
 * fallback for platform-specific optional packages that are not installed on every machine
 * (config/compliance/optional-licences.json). Fully offline and deterministic.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { cmp, integrityHash, licenceEntry, npmPurl, type CycloneDxBom, type CycloneDxComponent } from './cyclonedx.ts';
import { parseSpdx, type ComponentLicence } from './policy.ts';

export interface NpmComponent extends ComponentLicence {
  ecosystem: 'npm';
  integrity?: string;
  /** Package keys (`name@version`) this package depends on. */
  dependsOn: string[];
  /** Workspaces (importer paths, `.` = root) that declare the package directly. */
  usedBy: Array<{ workspace: string; dev: boolean }>;
}

export type LicenceResolver = (name: string, version: string) => string | null;

interface LockSection {
  specifier?: string;
  version?: string;
}
interface Lockfile {
  importers?: Record<string, Record<string, Record<string, LockSection>>>;
  packages?: Record<string, { resolution?: { integrity?: string } }>;
  snapshots?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** pnpm writes an environment lockfile document first; the workspace lockfile is the last document. */
export function parseLockfile(text: string): Lockfile {
  const docs = parseAllDocuments(text).map((d) => d.toJS() as Lockfile);
  const last = docs.at(-1);
  if (!last?.packages || !last.snapshots) throw new Error('pnpm-lock.yaml: no packages/snapshots section found');
  return last;
}

const stripPeers = (s: string): string => s.replace(/\(.*$/, '');

/** `name` + lockfile reference (`1.2.3(peer@1)` or `real-name@1.2.3` for aliases) → package key and snapshot key. */
function resolveRef(name: string, ref: string): { pkg: string; snapshot: string } | undefined {
  if (ref.startsWith('link:') || ref.startsWith('file:') || ref.startsWith('workspace:')) return undefined;
  const real = /^\d/.test(ref) ? `${name}@${ref}` : ref;
  return { pkg: stripPeers(real), snapshot: real };
}

export function buildNpmComponents(lockfileText: string, resolveLicence: LicenceResolver): NpmComponent[] {
  const lock = parseLockfile(lockfileText);
  const snapshots = lock.snapshots ?? {};
  const edges = (snapshotKey: string): Array<{ pkg: string; snapshot: string }> => {
    const s = snapshots[snapshotKey];
    return Object.entries({ ...s?.dependencies, ...s?.optionalDependencies }).flatMap(([n, r]) => {
      const ref = resolveRef(n, r);
      return ref ? [ref] : [];
    });
  };

  // Which packages are reachable from a production dependency of some workspace?
  const prod = new Set<string>();
  const direct = new Map<string, Array<{ workspace: string; dev: boolean }>>();
  const queue: string[] = [];
  for (const [workspace, sections] of Object.entries(lock.importers ?? {})) {
    for (const section of DEP_SECTIONS) {
      for (const [name, dep] of Object.entries(sections[section] ?? {})) {
        const ref = dep.version ? resolveRef(name, dep.version) : undefined;
        if (!ref) continue;
        const list = direct.get(ref.pkg) ?? [];
        list.push({ workspace, dev: section === 'devDependencies' });
        direct.set(ref.pkg, list);
        if (section !== 'devDependencies') queue.push(ref.snapshot);
      }
    }
  }
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (prod.has(key)) continue;
    prod.add(key);
    for (const e of edges(key)) queue.push(e.snapshot);
  }
  const prodPackages = new Set([...prod].map(stripPeers));

  const dependsOn = new Map<string, Set<string>>();
  for (const key of Object.keys(snapshots)) {
    const set = dependsOn.get(stripPeers(key)) ?? new Set<string>();
    for (const e of edges(key)) set.add(e.pkg);
    dependsOn.set(stripPeers(key), set);
  }

  return Object.entries(lock.packages ?? {})
    .map(([key, meta]): NpmComponent => {
      const at = key.lastIndexOf('@');
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const usedBy = (direct.get(key) ?? []).toSorted(
        (a, b) => cmp(a.workspace, b.workspace) || Number(a.dev) - Number(b.dev),
      );
      const component: NpmComponent = {
        ecosystem: 'npm',
        name,
        version,
        licence: resolveLicence(name, version),
        scope: prodPackages.has(key) ? 'runtime' : 'dev',
        direct: usedBy.length > 0,
        dependsOn: [...(dependsOn.get(key) ?? [])].toSorted(cmp),
        usedBy,
      };
      if (meta.resolution?.integrity) component.integrity = meta.resolution.integrity;
      return component;
    })
    .toSorted((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
}

// --- Licence data ----------------------------------------------------------------------------------------------

const licenceOne = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  const type = v && typeof v === 'object' ? (v as { type?: unknown }).type : undefined;
  return typeof type === 'string' ? type : null;
};

function licenceOf(pkg: { license?: unknown; licenses?: unknown }): string | null {
  if (pkg.license !== undefined) return licenceOne(pkg.license);
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map(licenceOne).filter((x): x is string => x !== null);
    return ids.length === 0 ? null : ids.length === 1 ? (ids[0] ?? null) : `(${ids.join(' OR ')})`;
  }
  return null;
}

/** `name@version` → licence for every package installed under node_modules/.pnpm. */
export function scanInstalledLicences(root: string): Map<string, string | null> {
  const store = join(root, 'node_modules', '.pnpm');
  const found = new Map<string, string | null>();
  if (!existsSync(store)) return found;
  for (const dir of readdirSync(store)) {
    const modules = join(store, dir, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const entry of readdirSync(modules)) {
      const names = entry.startsWith('@') ? readdirSync(join(modules, entry)).map((n) => `${entry}/${n}`) : [entry];
      for (const name of names) {
        const file = join(modules, name, 'package.json');
        if (!existsSync(file)) continue;
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
          name?: string;
          version?: string;
          license?: unknown;
          licenses?: unknown;
        };
        if (pkg.name === name && pkg.version) found.set(`${name}@${pkg.version}`, licenceOf(pkg));
      }
    }
  }
  return found;
}

export interface OptionalLicenceRule {
  /** Package name, or a prefix glob ending in `*`. */
  pattern: string;
  licence: string;
  reason?: string;
}

const patternMatches = (pattern: string, name: string): boolean =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/**
 * Resolver: installed package.json first; for packages that are not installed on this platform, the committed
 * fallback rule. A rule that contradicts an installed sibling's licence is a hard error (stale rule).
 */
export function makeResolver(installed: Map<string, string | null>, rules: OptionalLicenceRule[]): LicenceResolver {
  for (const rule of rules) {
    for (const [key, licence] of installed) {
      const name = key.slice(0, key.lastIndexOf('@'));
      if (patternMatches(rule.pattern, name) && licence !== rule.licence) {
        throw new Error(
          `optional-licences.json: rule "${rule.pattern}" says ${rule.licence} but ${key} declares ${licence}`,
        );
      }
    }
  }
  return (name, version) => {
    const key = `${name}@${version}`;
    if (installed.has(key)) return installed.get(key) ?? null;
    return rules.find((r) => patternMatches(r.pattern, name))?.licence ?? null;
  };
}

export function loadOptionalRules(root: string): OptionalLicenceRule[] {
  const file = join(root, 'config', 'compliance', 'optional-licences.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { rules: OptionalLicenceRule[] }).rules : [];
}

export function collectNpm(root: string): { components: NpmComponent[]; lockfileSha256: string; lockfile: string } {
  const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const resolver = makeResolver(scanInstalledLicences(root), loadOptionalRules(root));
  return {
    components: buildNpmComponents(lockfile, resolver),
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    lockfile,
  };
}

// --- CycloneDX --------------------------------------------------------------------------------------------------

const ref = (c: { name: string; version: string }): string => npmPurl(c.name, c.version);

/** Deterministic CycloneDX 1.6 SBOM: sorted, no serialNumber, no timestamp, lockfile SHA-256 in the metadata. */
export function buildNpmSbom(lockfileText: string, resolveLicence: LicenceResolver, rootName = 'olcys'): CycloneDxBom {
  const components = buildNpmComponents(lockfileText, resolveLicence);
  const lockfileSha256 = createHash('sha256').update(lockfileText).digest('hex');
  return npmComponentsToBom(components, lockfileSha256, rootName);
}

export function npmComponentsToBom(
  components: NpmComponent[],
  lockfileSha256: string,
  rootName = 'olcys',
): CycloneDxBom {
  const cdx = components.map((c): CycloneDxComponent => {
    const hash = integrityHash(c.integrity);
    const licences = licenceEntry(c.licence, c.licence !== null && parseSpdx(c.licence) !== undefined);
    const group = c.name.startsWith('@') ? c.name.split('/')[0] : undefined;
    return {
      type: 'library',
      'bom-ref': ref(c),
      ...(group ? { group } : {}),
      name: group ? c.name.slice(group.length + 1) : c.name,
      version: c.version,
      scope: c.scope === 'runtime' ? 'required' : 'excluded',
      purl: ref(c),
      ...(hash ? { hashes: [hash] } : {}),
      ...(licences ? { licenses: licences } : {}),
    };
  });
  const byKey = new Map(components.map((c) => [`${c.name}@${c.version}`, c]));
  const rootDeps = components.filter((c) => c.direct).map(ref);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', 'bom-ref': `pkg:npm/${rootName}`, name: rootName, version: '0.0.0' },
      properties: [
        { name: 'olcys:lockfile-sha256', value: lockfileSha256 },
        { name: 'olcys:source', value: 'pnpm-lock.yaml + installed package.json licences (offline)' },
      ],
    },
    components: cdx.toSorted((a, b) => cmp(a['bom-ref'], b['bom-ref'])),
    dependencies: [
      { ref: `pkg:npm/${rootName}`, dependsOn: rootDeps.toSorted(cmp) },
      ...components
        .map((c) => ({
          ref: ref(c),
          dependsOn: c.dependsOn
            .flatMap((k) => (byKey.has(k) ? [ref(byKey.get(k) as NpmComponent)] : []))
            .toSorted(cmp),
        }))
        .toSorted((a, b) => cmp(a.ref, b.ref)),
    ],
  };
}
