/**
 * Writes the CycloneDX 1.6 SBOMs (default) or, with --check, builds them in memory and fails on any gate violation
 * (denied or unreviewed licence, component without licence). Offline and deterministic; nothing is diffed against files.
 *
 *   pnpm compliance:sbom [--check] [--only npm|python] [--out-dir <dir>]
 *
 * Default output (git-ignored): data/sbom/olcys-npm.cdx.json and olcys-osint-py.cdx.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext, NPM_SBOM, PYTHON_SBOM, SBOM_DIR } from './context.ts';
import { serialise } from './cyclonedx.ts';
import { npmComponentsToBom } from './npm.ts';
import { buildPythonSbom } from './python.ts';
import { decideComponent, REPO_ROOT } from './policy.ts';

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

if (values.check) {
  const problems = [...ctx.npm, ...ctx.python].flatMap((c) => {
    const d = decideComponent(c, ctx.policy, ctx.exceptions);
    return d.verdict === 'allow'
      ? []
      : [`${d.verdict.toUpperCase()}: ${c.ecosystem} ${c.name}@${c.version} (${d.rule})`];
  });
  const lockCount = ctx.npm.length;
  const bomCount = JSON.parse(targets.find((t) => t.id === 'npm')?.body ?? '{"components":[]}').components.length;
  if (values.only !== 'python' && bomCount !== lockCount)
    problems.push(`npm SBOM has ${bomCount} components for ${lockCount} packages`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`SBOMs build cleanly: ${targets.map((t) => t.file).join(', ')}`);
} else {
  await Promise.all(
    targets.map(async (target) => {
      const path = join(outDir, target.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, target.body);
      console.log(`wrote ${path}`);
    }),
  );
}
