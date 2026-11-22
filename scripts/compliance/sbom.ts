/**
 * Writes (default) or verifies (--check) the CycloneDX 1.6 SBOMs, offline and deterministic.
 *
 *   pnpm compliance:sbom [--check] [--only npm|python] [--out-dir <dir>]
 *
 * Default output: docs/compliance/sbom/olcys-npm.cdx.json and olcys-osint-py.cdx.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext, NPM_SBOM, PYTHON_SBOM, SBOM_DIR } from './context.ts';
import { serialise } from './cyclonedx.ts';
import { npmComponentsToBom } from './npm.ts';
import { buildPythonSbom } from './python.ts';
import { REPO_ROOT } from './policy.ts';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    only: { type: 'string' },
    'out-dir': { type: 'string' },
  },
  strict: true,
});
if (values.only !== undefined && values.only !== 'npm' && values.only !== 'python') {
  console.error('--only must be npm or python');
  process.exit(2);
}

const ctx = await loadContext();
const outDir = values['out-dir'] ?? join(REPO_ROOT, SBOM_DIR);
const targets = [
  ...(values.only !== 'python'
    ? [{ id: 'npm', file: NPM_SBOM, body: serialise(npmComponentsToBom(ctx.npm, ctx.lockfileSha256)) }]
    : []),
  ...(values.only !== 'npm'
    ? [{ id: 'python', file: PYTHON_SBOM, body: serialise(buildPythonSbom(ctx.pythonInput)) }]
    : []),
];

const results = await Promise.all(
  targets.map(async (target) => {
    const path = join(outDir, target.file);
    if (!values.check) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, target.body);
      return { path, stale: false, message: `wrote ${path}` };
    }
    const current = await readFile(path, 'utf8').catch(() => undefined);
    const stale = current !== target.body;
    return {
      path,
      stale,
      message: stale ? `${path} is out of date: run "pnpm compliance:sbom"` : `${path} is up to date`,
    };
  }),
);
for (const r of results) (r.stale ? console.error : console.log)(r.message);
process.exit(results.some((r) => r.stale) ? 1 : 0);
