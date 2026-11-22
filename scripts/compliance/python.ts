/**
 * Python side of the SBOM (services/osint-py). Offline: reads pyproject.toml (exact `==` pins) and, when committed,
 * uv.lock (full transitive set with sdist hashes). Licences are not in either file, so they come from the reviewed
 * table in config/compliance/components.yaml (`python:`); a package missing from it has no licence and fails the gate.
 *
 * Not covered: without uv.lock only the direct dependencies are listed (no transitive packages); licences are the
 * reviewed declarations, not read from installed wheels; dependency groups / extras are ignored.
 */
import { createHash } from 'node:crypto';
import { cmp, licenceEntry, pypiPurl, type CycloneDxBom, type CycloneDxComponent } from './cyclonedx.ts';
import { parseSpdx, type ComponentLicence } from './policy.ts';

export interface PythonComponent extends ComponentLicence {
  ecosystem: 'pypi';
  sha256?: string;
  dependsOn: string[];
}

const norm = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

export interface PythonInput {
  pyproject: string;
  uvLock?: string;
  /** normalised package name → SPDX expression */
  licences: Record<string, string>;
}

/** `dependencies = ["fastapi==0.165.0", ...]` of [project] → name → pinned version. */
export function parsePyprojectDeps(pyproject: string): Map<string, string> {
  const header = /^[ \t]*\[project\][ \t]*(?:#.*)?$/m.exec(pyproject);
  if (!header) throw new Error('pyproject.toml: no [project] table found');
  const rest = pyproject.slice(header.index + header[0].length);
  const next = /^[ \t]*\[/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const deps = new Map<string, string>();
  for (const entry of quotedList(section, 'dependencies')) {
    const spec = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;,]+)/.exec(entry.trim());
    if (!spec) throw new Error(`pyproject.toml: dependency "${entry}" is not pinned with == (exact pins required)`);
    deps.set(norm(spec[1] ?? ''), spec[2] ?? '');
  }
  return deps;
}

/**
 * Quoted strings of `key = [ "a", 'b' ]` in a TOML section. Brackets inside strings (extras such as
 * `uvicorn[standard]==1`) are part of the string; anything this scanner does not understand is an error, never a
 * partial list.
 */
function quotedList(section: string, key: string): string[] {
  const assignment = new RegExp(`^[ \\t]*${key}[ \\t]*=`, 'm').exec(section);
  if (!assignment) return [];
  const start = new RegExp(`^[ \\t]*${key}[ \\t]*=\\s*\\[`, 'm').exec(section);
  if (!start) throw new Error(`pyproject.toml: "${key}" must be an array of strings`);
  const out: string[] = [];
  let i = start.index + start[0].length;
  for (;;) {
    while (i < section.length && /[\s,]/.test(section[i] ?? '')) i++;
    if (section[i] === '#') {
      while (i < section.length && section[i] !== '\n') i++;
      continue;
    }
    const ch = section[i];
    if (ch === ']') return out;
    if (ch !== '"' && ch !== "'") throw new Error(`pyproject.toml: cannot parse the "${key}" list near offset ${i}`);
    const end = section.indexOf(ch, i + 1);
    if (end === -1 || section.slice(i + 1, end).includes('\n'))
      throw new Error(`pyproject.toml: unterminated string in "${key}"`);
    const value = section.slice(i + 1, end);
    if (ch === '"' && value.includes('\\')) throw new Error(`pyproject.toml: escapes in "${key}" are not supported`);
    out.push(value);
    i = end + 1;
  }
}

interface LockPackage {
  name: string;
  version: string;
  virtual: boolean;
  sha256?: string;
  deps: string[];
}

/** Line-based reader for the fields we need from uv.lock (no TOML parser in Node). */
export function parseUvLock(text: string): LockPackage[] {
  return text
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block): LockPackage => {
      const head = block.split(/^\[/m)[0] ?? block;
      const name = /^name = "([^"]+)"/m.exec(head)?.[1] ?? '';
      const version = /^version = "([^"]+)"/m.exec(head)?.[1] ?? '';
      const source = /^source = (\{[^\n]*\})/m.exec(head)?.[1] ?? '';
      const depsBlock = /^dependencies = \[([\s\S]*?)^\]/m.exec(head)?.[1] ?? '';
      const sdist = /^sdist = \{[^\n]*hash = "sha256:([0-9a-f]+)"/m.exec(head)?.[1];
      const pkg: LockPackage = {
        name: norm(name),
        version,
        virtual: /virtual|editable/.test(source),
        deps: [...depsBlock.matchAll(/name = "([^"]+)"/g)].map((m) => norm(m[1] ?? '')),
      };
      if (sdist) pkg.sha256 = sdist;
      return pkg;
    })
    .filter((p) => p.name !== '');
}

export function buildPythonComponents(input: PythonInput): PythonComponent[] {
  const direct = parsePyprojectDeps(input.pyproject);
  const locked = input.uvLock ? parseUvLock(input.uvLock).filter((p) => !p.virtual) : [];
  const byName = new Map(locked.map((p) => [p.name, p]));

  const names = new Set<string>(direct.keys());
  const queue = [...direct.keys()];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    for (const dep of byName.get(name)?.deps ?? []) {
      if (!names.has(dep) && byName.has(dep)) {
        names.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...names]
    .map((name): PythonComponent => {
      const lock = byName.get(name);
      const version = lock?.version ?? direct.get(name) ?? '';
      const pinned = direct.get(name);
      if (lock && pinned && lock.version !== pinned) {
        throw new Error(`uv.lock has ${name} ${lock.version} but pyproject.toml pins ${pinned}`);
      }
      const component: PythonComponent = {
        ecosystem: 'pypi',
        name,
        version,
        licence: input.licences[name] ?? null,
        scope: 'runtime',
        direct: direct.has(name),
        workspace: 'services/osint-py',
        dependsOn: (lock?.deps ?? []).filter((d) => names.has(d)).toSorted(cmp),
      };
      if (lock?.sha256) component.sha256 = lock.sha256;
      return component;
    })
    .toSorted((a, b) => cmp(a.name, b.name));
}

const ref = (c: { name: string; version: string }): string => pypiPurl(c.name, c.version);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export function buildPythonSbom(input: PythonInput): CycloneDxBom {
  const components = buildPythonComponents(input);
  const byName = new Map(components.map((c) => [c.name, c]));
  const cdx = components.map((c): CycloneDxComponent => {
    const licences = licenceEntry(c.licence, c.licence !== null && parseSpdx(c.licence) !== undefined);
    return {
      type: 'library',
      'bom-ref': ref(c),
      name: c.name,
      version: c.version,
      scope: 'required',
      purl: ref(c),
      ...(c.sha256 ? { hashes: [{ alg: 'SHA-256', content: c.sha256 }] } : {}),
      ...(licences ? { licenses: licences } : {}),
    };
  });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', 'bom-ref': 'pkg:pypi/olcys-osint', name: 'olcys-osint', version: '0.0.0' },
      properties: [
        { name: 'olcys:pyproject-sha256', value: sha(input.pyproject) },
        ...(input.uvLock ? [{ name: 'olcys:uv-lock-sha256', value: sha(input.uvLock) }] : []),
        {
          name: 'olcys:coverage',
          value: input.uvLock
            ? 'direct and transitive packages from uv.lock; licences from the reviewed table in config/compliance/components.yaml'
            : 'direct dependencies only (no uv.lock committed); licences from the reviewed table in config/compliance/components.yaml',
        },
      ],
    },
    components: cdx.toSorted((a, b) => cmp(a['bom-ref'], b['bom-ref'])),
    dependencies: [
      {
        ref: 'pkg:pypi/olcys-osint',
        dependsOn: components
          .filter((c) => c.direct)
          .map(ref)
          .toSorted(cmp),
      },
      ...components.map((c) => ({
        ref: ref(c),
        dependsOn: c.dependsOn
          .flatMap((n) => (byName.has(n) ? [ref(byName.get(n) as PythonComponent)] : []))
          .toSorted(cmp),
      })),
    ].toSorted((a, b) => cmp(a.ref, b.ref)),
  };
}
