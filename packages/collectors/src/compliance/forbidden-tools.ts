/**
 * `config/forbidden-tools.yaml`: tools and packages the project must not use, and the dependency scan that enforces
 * it over workspace manifests, Python manifests, compose files and Dockerfiles.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from '../framework/config.ts';
import { SourceConfigError } from '../framework/errors.ts';

export const DEFAULT_FORBIDDEN_TOOLS_PATH = join(REPO_ROOT, 'config', 'forbidden-tools.yaml');

export const FORBIDDEN_CATEGORIES = [
  'breach_data',
  'account_probing',
  'session_login',
  'scraping_evasion',
  'licence',
  'telemetry',
  'unmaintained',
] as const;
export type ForbiddenCategory = (typeof FORBIDDEN_CATEGORIES)[number];

export interface ForbiddenTool {
  id: string;
  name: string;
  category: ForbiddenCategory;
  reason: { pl: string; en: string };
  packages: { npm: string[]; pypi: string[]; images: string[] };
  url: string;
}

export interface FeatureRule {
  tool: string;
  name: string;
  pl: string[];
  en: string[];
}

export interface ForbiddenTools {
  version: string;
  tools: ForbiddenTool[];
  featureRules: FeatureRule[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseForbiddenTools(text: string): ForbiddenTools {
  const problems: string[] = [];
  const raw: unknown = parseYaml(text, { uniqueKeys: true });
  if (!isRecord(raw) || typeof raw['version'] !== 'string') throw new SourceConfigError(['version: required']);
  const tools: ForbiddenTool[] = [];
  const rawTools = isRecord(raw['tools']) ? raw['tools'] : {};
  for (const [id, entry] of Object.entries(rawTools)) {
    const at = `tools.${id}`;
    if (!isRecord(entry)) {
      problems.push(`${at}: must be a mapping`);
      continue;
    }
    const reason = isRecord(entry['reason']) ? entry['reason'] : {};
    const packages = isRecord(entry['packages']) ? entry['packages'] : {};
    const category = entry['category'];
    if (!FORBIDDEN_CATEGORIES.some((c) => c === category)) problems.push(`${at}.category: unknown category`);
    for (const lang of ['pl', 'en'] as const) {
      if (typeof reason[lang] !== 'string' || !reason[lang].trim()) problems.push(`${at}.reason.${lang}: required`);
    }
    if (typeof entry['url'] !== 'string' || !/^https?:\/\//.test(entry['url'])) problems.push(`${at}.url: required`);
    tools.push({
      id,
      name: typeof entry['name'] === 'string' ? entry['name'] : id,
      category: category as ForbiddenCategory,
      reason: { pl: String(reason['pl'] ?? ''), en: String(reason['en'] ?? '') },
      packages: { npm: strings(packages['npm']), pypi: strings(packages['pypi']), images: strings(packages['images']) },
      url: String(entry['url'] ?? ''),
    });
  }
  const featureRules: FeatureRule[] = [];
  const rawRules = isRecord(raw['featureRules']) ? raw['featureRules'] : {};
  for (const [tool, rule] of Object.entries(rawRules)) {
    if (!isRecord(rule)) {
      problems.push(`featureRules.${tool}: must be a mapping`);
      continue;
    }
    featureRules.push({
      tool,
      name: typeof rule['name'] === 'string' ? rule['name'] : tool,
      pl: strings(rule['pl']),
      en: strings(rule['en']),
    });
  }
  if (problems.length) throw new SourceConfigError(problems);
  return { version: raw['version'], tools, featureRules };
}

export async function loadForbiddenTools(path: string = DEFAULT_FORBIDDEN_TOOLS_PATH): Promise<ForbiddenTools> {
  return parseForbiddenTools(await readFile(path, 'utf8'));
}

// --- Dependency scan -------------------------------------------------------------------------------------------

export interface ForbiddenDependency {
  toolId: string;
  toolName: string;
  ecosystem: 'npm' | 'pypi' | 'image';
  /** The dependency as found (package name or image reference). */
  dependency: string;
  /** Path relative to the scanned root. */
  file: string;
  reason: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.venv', '__pycache__', 'coverage']);
const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

async function listFiles(root: string, dir: string = root): Promise<string[]> {
  const nested = (await readdir(dir, { withFileTypes: true })).map((entry) => {
    if (!entry.isDirectory()) return Promise.resolve([join(dir, entry.name)]);
    return SKIP_DIRS.has(entry.name) ? Promise.resolve([]) : listFiles(root, join(dir, entry.name));
  });
  return (await Promise.all(nested)).flat();
}

const normalisePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

function npmMatches(pattern: string, name: string): boolean {
  return pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** Package named by an `npm:` alias spec (`npm:turbo@2.0.0`, `npm:@scope/pkg`), else undefined. */
export function npmAliasTarget(spec: string): string | undefined {
  if (!spec.startsWith('npm:')) return undefined;
  const target = spec.slice(4);
  const at = target.indexOf('@', target.startsWith('@') ? 1 : 0);
  return (at === -1 ? target : target.slice(0, at)) || undefined;
}

/** Python requirement names in a pyproject.toml, requirements*.txt or uv.lock (no TOML parser: quoted/plain lines). */
function pythonNames(file: string, text: string): string[] {
  const names: string[] = [];
  const requirement = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@(].*)?$/;
  if (basename(file) === 'uv.lock') {
    for (const m of text.matchAll(/^name = "([^"]+)"/gm)) names.push(m[1] ?? '');
  } else if (file.endsWith('.toml')) {
    for (const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
      const m2 = requirement.exec((m[1] ?? m[2] ?? '').trim());
      if (m2) names.push(m2[1] ?? '');
    }
  } else {
    for (const line of text.split('\n')) {
      const m2 = requirement.exec(line.replace(/#.*$/, '').trim());
      if (m2) names.push(m2[1] ?? '');
    }
  }
  return names;
}

/** Image references in compose files (`image:`) and Dockerfiles (`FROM`). */
function imageRefs(file: string, text: string): string[] {
  const refs: string[] = [];
  const isDockerfile = /^Dockerfile/i.test(basename(file));
  for (const line of text.split('\n')) {
    const m = isDockerfile ? /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line) : /^\s*image:\s*["']?([^\s"'#]+)/.exec(line);
    if (m?.[1]) refs.push(m[1]);
  }
  return refs;
}

/** Splits `registry/ns/name:tag@digest` into the repository path and the tag. */
function splitImage(ref: string): { path: string; tag: string | undefined } {
  const noDigest = ref.split('@')[0] ?? ref;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.indexOf(':', slash + 1);
  return colon === -1
    ? { path: noDigest, tag: undefined }
    : { path: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) };
}

export function imageMatches(pattern: string, ref: string): boolean {
  const m = /^(.+?)(?:>=(\d+))?$/.exec(pattern);
  const wanted = (m?.[1] ?? pattern).toLowerCase();
  const minMajor = m?.[2] ? Number(m[2]) : undefined;
  const { path, tag } = splitImage(ref.toLowerCase());
  const segments = path.split('/');
  const candidates = [segments.at(-1) ?? '', segments.slice(-2).join('/')];
  if (!candidates.includes(wanted)) return false;
  if (minMajor === undefined) return true;
  const major = /^v?(\d+)/.exec(tag ?? '')?.[1];
  return major === undefined || Number(major) >= minMajor;
}

/**
 * Finds forbidden dependencies under `root`: every package.json (dependency sections), Python manifests
 * (pyproject.toml, requirements*.txt, uv.lock), compose files and Dockerfiles. Each hit names the tool, the package
 * and the reason (Polish text first, as in the UI).
 */
export async function scanForbiddenDependencies(
  tools: ForbiddenTools,
  root: string = REPO_ROOT,
): Promise<ForbiddenDependency[]> {
  const scanFile = async (file: string): Promise<ForbiddenDependency[]> => {
    const hits: ForbiddenDependency[] = [];
    const add = (tool: ForbiddenTool, ecosystem: ForbiddenDependency['ecosystem'], dependency: string) =>
      hits.push({
        toolId: tool.id,
        toolName: tool.name,
        ecosystem,
        dependency,
        file: relative(root, file),
        reason: tool.reason.en,
      });
    const name = basename(file);
    if (name === 'package.json') {
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        throw new Error(
          `cannot scan ${relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        );
      }
      if (!isRecord(manifest)) throw new Error(`cannot scan ${relative(root, file)}: not a JSON object`);
      for (const section of NPM_SECTIONS) {
        const deps = manifest[section];
        if (!isRecord(deps)) continue;
        for (const [key, spec] of Object.entries(deps)) {
          // An alias ("task-runner": "npm:turbo@2.0.0") installs the package named in the value.
          const aliased = typeof spec === 'string' ? npmAliasTarget(spec) : undefined;
          for (const dep of aliased && aliased !== key ? [key, aliased] : [key]) {
            for (const tool of tools.tools) {
              if (tool.packages.npm.some((p) => npmMatches(p, dep)))
                add(tool, 'npm', dep === key ? dep : `${key} (${dep})`);
            }
          }
        }
      }
    } else if (name === 'pyproject.toml' || name === 'uv.lock' || /^requirements.*\.txt$/.test(name)) {
      const names = pythonNames(file, await readFile(file, 'utf8')).map(normalisePypi);
      for (const dep of new Set(names)) {
        for (const tool of tools.tools) {
          if (tool.packages.pypi.some((p) => normalisePypi(p) === dep)) add(tool, 'pypi', dep);
        }
      }
    } else if (/^(docker-)?compose.*\.ya?ml$/.test(name) || /^Dockerfile/i.test(name)) {
      for (const ref of imageRefs(file, await readFile(file, 'utf8'))) {
        for (const tool of tools.tools) {
          if (tool.packages.images.some((p) => imageMatches(p, ref))) add(tool, 'image', ref);
        }
      }
    }
    return hits;
  };
  const files = (await listFiles(root)).toSorted();
  return (await Promise.all(files.map(scanFile))).flat();
}

export function describeForbiddenDependency(hit: ForbiddenDependency): string {
  return `${hit.file}: ${hit.ecosystem} dependency "${hit.dependency}" is forbidden (${hit.toolName}): ${hit.reason}`;
}
