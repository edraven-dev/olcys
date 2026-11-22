/** Loads every input of the compliance scripts from a repository root. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { collectNpm, type NpmComponent } from './npm.ts';
import { buildPythonComponents, type PythonComponent } from './python.ts';
import {
  applyExceptions,
  loadExceptions,
  loadPolicy,
  REPO_ROOT,
  type LicenceException,
  type LicencePolicy,
} from './policy.ts';

export const SBOM_DIR = 'data/sbom';
export const NPM_SBOM = 'olcys-npm.cdx.json';
export const PYTHON_SBOM = 'olcys-osint-py.cdx.json';
export const PYTHON_DIR = 'services/osint-py';

export interface Components {
  npmPurposes: Record<string, string>;
  python: Record<string, { licence: string; purpose: string }>;
}

export async function loadComponents(root: string): Promise<Components> {
  const doc = parse(await readFile(join(root, 'config', 'compliance', 'components.yaml'), 'utf8')) as {
    npm?: Record<string, string>;
    python?: Record<string, { licence: string; purpose: string }>;
  };
  return { npmPurposes: doc.npm ?? {}, python: doc.python ?? {} };
}

export interface Context {
  root: string;
  policy: LicencePolicy;
  exceptions: LicenceException[];
  components: Components;
  npm: NpmComponent[];
  lockfileSha256: string;
  python: PythonComponent[];
  pythonInput: { pyproject: string; uvLock?: string; licences: Record<string, string> };
}

export async function loadContext(root: string = REPO_ROOT): Promise<Context> {
  const components = await loadComponents(root);
  const npm = collectNpm(root);
  const pyproject = await readFile(join(root, PYTHON_DIR, 'pyproject.toml'), 'utf8');
  const lockPath = join(root, PYTHON_DIR, 'uv.lock');
  const pythonInput = {
    pyproject,
    ...(existsSync(lockPath) ? { uvLock: await readFile(lockPath, 'utf8') } : {}),
    licences: Object.fromEntries(Object.entries(components.python).map(([n, v]) => [n, v.licence])),
  };
  const policy = await loadPolicy(root);
  const exceptions = await loadExceptions(root);
  return {
    root,
    policy,
    exceptions,
    components,
    npm: applyExceptions(npm.components, policy, exceptions),
    lockfileSha256: npm.lockfileSha256,
    python: applyExceptions(buildPythonComponents(pythonInput), policy, exceptions),
    pythonInput,
  };
}
